/**
 * VeriFlow MCP server
 * -------------------
 * 讓任何 MCP agent（例如 Claude）直接：
 *   get_signal         付款（x402，testnet CCD）買一個 RISK_ON / RISK_OFF 訊號
 *   get_track_record   看命中率（公開）
 *   list_commitments   看所有鏈上承諾（公開）
 *   verify_signal      直接向 Concordium 節點讀回承諾並驗證（不經過賣方的伺服器）；可貼上訊號內容一起驗
 *   check_eligibility  買方帳號是否已通過零知識資格驗證
 *
 * 付款用 BUYER_KEY_FILE 的帳號，花費護欄同示範 buyer（只付 CCD、單次上限 MAX_PAY_MICROCCD）。
 * 執行（stdio）：npm run mcp
 *
 * 注意：stdio 模式下 stdout 是 MCP 通訊管道，任何 console.log 都會弄壞協定，所以全部導到 stderr。
 */
console.log = console.error;

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ContractAddress } from "@concordium/web-sdk";
import { createBuyerAgent } from "./agent.js";
import { readAnchorTx, type OnChainAnchor } from "./anchor.js";
import { registryAddress, TESTNET_REGISTRY_INDEX } from "./contract.js";
import { createGrpc, grpcEndpoint } from "./grpc.js";
import { allOk, verifyCommitment } from "./verify.js";

const agent = createBuyerAgent();
const EXPLORER = "https://ccdexplorer.io/testnet/transaction/";

const json = (x: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(x, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

const INSTRUCTIONS =
  "VeriFlow sells a crypto risk-regime signal (RISK_ON / RISK_OFF for BTC or ETH). Each signal's SHA-256 commitment is " +
  "anchored on Concordium testnet before its 7-day outcome is known, so the track record cannot be edited afterwards. " +
  "Typical flow: (1) check_eligibility — the paying account must have passed a one-time zero-knowledge check " +
  "(age >= 18, not resident in a restricted country); if it has not, give the human the verify_url and stop, never try " +
  "to work around it. (2) get_track_record and list_commitments to judge the seller's verifiable history. " +
  "(3) get_signal pays about 1 testnet CCD. (4) verify_signal with the returned commitment and canonical string: it " +
  "reads the anchor straight from a Concordium node, so you do not have to trust VeriFlow's server. " +
  "Payments are Concordium testnet CCD only. Not investment advice.";

const server = new McpServer({ name: "veriflow", version: "0.2.0" }, { instructions: INSTRUCTIONS });

// ── 直接讀鏈：買方 agent 自己向 Concordium 節點確認，不必相信賣方的 /onchain ──
const NODE = grpcEndpoint().join(":");
const REGISTRY = registryAddress() ?? ContractAddress.create(TESTNET_REGISTRY_INDEX, 0n);
let grpc: ReturnType<typeof createGrpc> | undefined;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** 讀一次：先直接問 Concordium 節點；連不到（例如公司網路擋 20000 port）才退回 VeriFlow 的 /onchain，並清楚標示 */
async function readOnce(tx: string, direct: boolean): Promise<{ onchain: OnChainAnchor; source: string; direct: boolean }> {
  if (direct) {
    try {
      grpc ??= createGrpc();
      const onchain = await readAnchorTx(grpc, tx, REGISTRY);
      return { onchain, source: `Concordium node ${NODE} — read directly, VeriFlow's server is not involved`, direct: true };
    } catch (e) {
      grpc = undefined; // 下次重建連線
      const onchain = (await agent.get(`/onchain/${tx}`)) as OnChainAnchor;
      return { onchain, source: `VeriFlow gateway /onchain (fallback: could not reach Concordium node ${NODE}: ${errText(e)})`, direct: false };
    }
  }
  const onchain = (await agent.get(`/onchain/${tx}`)) as OnChainAnchor;
  return { onchain, source: `VeriFlow gateway /onchain (fallback: could not reach Concordium node ${NODE})`, direct: false };
}

/** 剛買到的訊號，上鏈交易可能還沒被打包：最多等約 30 秒 */
async function readSettled(tx: string) {
  let r = await readOnce(tx, true);
  for (let i = 0; r.onchain.status === "pending" && i < 10; i++) {
    await sleep(3000);
    r = await readOnce(tx, r.direct);
  }
  return r;
}

server.registerTool(
  "get_signal",
  {
    title: "Buy a VeriFlow signal",
    description:
      "Pay (x402, Concordium testnet CCD) for the latest risk-regime signal (RISK_ON / RISK_OFF) for BTC or ETH. " +
      "The signal's SHA-256 commitment is anchored on Concordium before the outcome is known. " +
      `Costs about 1 CCD; the agent refuses to pay more than ${Number(agent.maxPayMicroCcd) / 1e6} CCD. Not investment advice.`,
    inputSchema: { asset: z.enum(["BTC", "ETH"]).describe("Asset to get the signal for") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ asset }) => {
    try {
      const r = await agent.buySignal(asset);
      if (r.needsVerification)
        return fail(
          `The buyer account ${agent.address} has not proven eligibility (age ≥ 18, not in a restricted country). ` +
            `A human must verify once with the Concordium wallet at ${r.verifyUrl}. No payment was taken.`,
        );
      if (r.status !== 200) return fail(`Gateway returned HTTP ${r.status}: ${JSON.stringify(r.body)}`);
      const b = r.body as Record<string, unknown>;
      return json({
        ...b,
        paid_by: agent.address,
        payment_tx: r.payment?.transaction,
        payment_explorer: r.paymentExplorer,
        anchor_explorer: b.anchor_tx ? EXPLORER + b.anchor_tx : undefined,
        how_to_verify: "Call verify_signal with this commitment and canonical string.",
      });
    } catch (e) {
      return fail(`Could not buy signal: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

server.registerTool(
  "get_track_record",
  {
    title: "VeriFlow track record",
    description: "Hit rate of all signals whose 7-day horizon has passed. Every scored signal was committed on-chain before its outcome. Free.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    try {
      return json(await agent.get("/track-record"));
    } catch (e) {
      return fail(String(e));
    }
  },
);

server.registerTool(
  "list_commitments",
  {
    title: "List on-chain commitments",
    description: "All issued signals: commitment hash, asset, date, and the Concordium transaction that anchors it. Free.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    try {
      return json(await agent.get("/commitments"));
    } catch (e) {
      return fail(String(e));
    }
  },
);

server.registerTool(
  "verify_signal",
  {
    title: "Verify a signal against Concordium",
    description:
      "Read the commitment's anchor transaction straight from a Concordium node (not from VeriFlow's server) and check it: " +
      "confirmed, carries this commitment, and — with the canonical signal JSON you received (or the public one after " +
      "7 days) — that the content hashes to the commitment (any edit fails) and was anchored within a day of its data " +
      "close, long before the 7-day outcome.",
    inputSchema: {
      commitment: z.string().regex(/^[0-9a-f]{64}$/).describe("64-char SHA-256 commitment"),
      canonical: z.string().optional().describe("Exact canonical signal JSON string, if you have it"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ commitment, canonical }) => {
    try {
      const c = (await agent.get(`/commitments/${commitment}`)) as { anchor_tx?: string; canonical?: string; revealed?: boolean };
      if (!c.anchor_tx) return fail("This commitment exists but has not been anchored on-chain.");
      const { onchain, source } = await readSettled(c.anchor_tx);
      const content = canonical ?? c.canonical;
      const checks = verifyCommitment(commitment, onchain, content);
      return json({
        verified: allOk(checks),
        checks,
        anchor_tx: c.anchor_tx,
        anchor_explorer: EXPLORER + c.anchor_tx,
        anchored_at: onchain.block_time ?? undefined,
        read_from: source,
        registry_contract: `<${REGISTRY.index},${REGISTRY.subindex}>`,
        content_checked: content !== undefined,
        note:
          onchain.status === "pending"
            ? "The anchor transaction is not in a block yet; try again in a minute."
            : content === undefined
              ? "Signal content is revealed after the 7-day horizon; only the on-chain anchor was checked."
              : undefined,
      });
    } catch (e) {
      return fail(`Verification failed: ${errText(e)}`);
    }
  },
);

server.registerTool(
  "check_eligibility",
  {
    title: "Check buyer eligibility",
    description: "Whether a Concordium account has passed VeriFlow's zero-knowledge eligibility check (age ≥ 18, not in a restricted country). Defaults to this agent's own account.",
    inputSchema: { account: z.string().optional().describe("Concordium address; defaults to this agent's paying account") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ account }) => {
    try {
      const a = account ?? agent.address;
      const r = (await agent.get(`/eligibility/${encodeURIComponent(a)}`)) as { eligible: boolean };
      return json({ account: a, ...r, verify_url: r.eligible ? undefined : `${agent.gateway}/verify?account=${a}` });
    } catch (e) {
      return fail(String(e));
    }
  },
);

await server.connect(new StdioServerTransport());
console.error(`veriflow MCP ready (buyer ${agent.address}, gateway ${agent.gateway})`);
