/**
 * VeriFlow MCP server
 * -------------------
 * 讓任何 MCP agent（例如 Claude）直接：
 *   get_signal         付款（x402，testnet CCD）買一個 RISK_ON / RISK_OFF 訊號
 *   get_track_record   看命中率（公開）
 *   list_commitments   看所有鏈上承諾（公開）
 *   verify_signal      從 Concordium 讀回承諾並驗證；可貼上訊號內容一起驗
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
import { createBuyerAgent } from "./agent.js";
import { allOk, verifyCommitment } from "./verify.js";

const agent = createBuyerAgent();
const EXPLORER = "https://ccdexplorer.io/testnet/transaction/";

const json = (x: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(x, null, 2) }] });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });

const server = new McpServer({ name: "veriflow", version: "0.1.0" });

server.registerTool(
  "get_signal",
  {
    title: "Buy a VeriFlow signal",
    description:
      "Pay (x402, Concordium testnet CCD) for the latest risk-regime signal (RISK_ON / RISK_OFF) for BTC or ETH. " +
      "The signal's SHA-256 commitment is anchored on Concordium before the outcome is known. " +
      `Costs about 1 CCD; the agent refuses to pay more than ${Number(agent.maxPayMicroCcd) / 1e6} CCD. Not investment advice.`,
    inputSchema: { asset: z.enum(["BTC", "ETH"]).describe("Asset to get the signal for") },
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
      "Read the commitment's anchor transaction back from Concordium and check it. If you pass the canonical signal JSON " +
      "you received (or the public one after 7 days), also check that it hashes to the commitment — any edit fails.",
    inputSchema: {
      commitment: z.string().regex(/^[0-9a-f]{64}$/).describe("64-char SHA-256 commitment"),
      canonical: z.string().optional().describe("Exact canonical signal JSON string, if you have it"),
    },
  },
  async ({ commitment, canonical }) => {
    try {
      const c = (await agent.get(`/commitments/${commitment}`)) as { anchor_tx?: string; canonical?: string; revealed?: boolean };
      if (!c.anchor_tx) return fail("This commitment exists but has not been anchored on-chain.");
      const onchain = await agent.get(`/onchain/${c.anchor_tx}`);
      const content = canonical ?? c.canonical;
      const checks = verifyCommitment(commitment, onchain as never, content);
      return json({
        verified: allOk(checks),
        checks,
        anchor_tx: c.anchor_tx,
        anchor_explorer: EXPLORER + c.anchor_tx,
        content_checked: content !== undefined,
        note: content === undefined ? "Signal content is revealed after the 7-day horizon; only the on-chain anchor was checked." : undefined,
      });
    } catch (e) {
      return fail(`Verification failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
);

server.registerTool(
  "check_eligibility",
  {
    title: "Check buyer eligibility",
    description: "Whether a Concordium account has passed VeriFlow's zero-knowledge eligibility check (age ≥ 18, not in a restricted country). Defaults to this agent's own account.",
    inputSchema: { account: z.string().optional().describe("Concordium address; defaults to this agent's paying account") },
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
