/**
 * MCP 工具：本機版（stdio，mcp.ts，會付款）與公開版（HTTP，mcp-http.ts，不付款）共用
 * ------------------------------------------------------------------------------
 * 免費工具（兩版都有）：get_track_record、list_commitments、verify_signal、check_eligibility
 * 只有本機版有：get_signal（付款）、check_seller（買方付款前驗證賣方）——要用買方自己的錢包，公開伺服器不碰任何人的金鑰
 */
import { ContractAddress } from "@concordium/web-sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readAnchorTx, type OnChainAnchor } from "./anchor.js";
import { registryAddress, TESTNET_REGISTRY_INDEX } from "./contract.js";
import { createGrpc, grpcEndpoint } from "./grpc.js";
import { allOk, verifyCommitment } from "./verify.js";

export const EXPLORER = "https://ccdexplorer.io/testnet/transaction/";
export const json = (x: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(x, null, 2) }] });
export const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export const ABOUT =
  "VeriFlow sells a crypto risk-regime signal (RISK_ON / RISK_OFF for BTC or ETH). Each signal's SHA-256 commitment is " +
  "anchored on Concordium testnet before its 7-day outcome is known, so the track record cannot be edited afterwards. ";

/** 公開端點的讀取方式（本機版：連 GATEWAY_URL；公開版：連自己） */
export type PublicApi = { get: (path: string) => Promise<unknown>; gateway: string };

export const REGISTRY = registryAddress() ?? ContractAddress.create(TESTNET_REGISTRY_INDEX, 0n);
const NODE = grpcEndpoint().join(":");

/**
 * 讀鏈上的承諾交易。先直接問 Concordium 節點；連不到（例如公司網路擋 20000 port）才退回賣方的 /onchain，並清楚標示。
 * whoReads：說明是誰在讀——本機 MCP 是買方自己；公開版是 VeriFlow 的伺服器
 */
export function createChainReader(api: PublicApi, whoReads: string) {
  let grpc: ReturnType<typeof createGrpc> | undefined;
  async function once(tx: string, direct: boolean): Promise<{ onchain: OnChainAnchor; source: string; direct: boolean }> {
    if (direct) {
      try {
        grpc ??= createGrpc();
        return { onchain: await readAnchorTx(grpc, tx, REGISTRY), source: `Concordium node ${NODE} — ${whoReads}`, direct: true };
      } catch (e) {
        grpc = undefined;
        const onchain = (await api.get(`/onchain/${tx}`)) as OnChainAnchor;
        return { onchain, source: `VeriFlow gateway /onchain (fallback: could not reach Concordium node ${NODE}: ${errText(e)})`, direct: false };
      }
    }
    return { onchain: (await api.get(`/onchain/${tx}`)) as OnChainAnchor, source: `VeriFlow gateway /onchain (fallback)`, direct: false };
  }
  /** 剛買到的訊號，上鏈交易可能還沒被打包：最多等約 30 秒 */
  return async function readSettled(tx: string) {
    let r = await once(tx, true);
    for (let i = 0; r.onchain.status === "pending" && i < 10; i++) {
      await sleep(3000);
      r = await once(tx, r.direct);
    }
    return r;
  };
}

/** 四個免費工具；defaultAccount：本機版預設查自己的付款帳號，公開版必須指定 */
export function registerPublicTools(
  server: McpServer,
  api: PublicApi,
  readSettled: ReturnType<typeof createChainReader>,
  defaultAccount?: string,
) {
  server.registerTool(
    "get_track_record",
    {
      title: "VeriFlow track record",
      description:
        "Hit rate of anchored signals whose 7-day horizon has passed, each asset-day counted once. Every scored signal was " +
        "committed on-chain before its outcome. Free.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      try {
        return json(await api.get("/track-record"));
      } catch (e) {
        return fail(errText(e));
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
        return json(await api.get("/commitments"));
      } catch (e) {
        return fail(errText(e));
      }
    },
  );

  server.registerTool(
    "verify_signal",
    {
      title: "Verify a signal against Concordium",
      description:
        "Read the commitment's anchor transaction straight from a Concordium node and check it: confirmed, carries this " +
        "commitment, and — with the canonical signal JSON you received (or the public one after 7 days) — that the content " +
        "hashes to the commitment (any edit fails) and was anchored within a day of its data close, long before the 7-day outcome.",
      inputSchema: {
        commitment: z.string().regex(/^[0-9a-f]{64}$/).describe("64-char SHA-256 commitment"),
        canonical: z.string().optional().describe("Exact canonical signal JSON string, if you have it"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ commitment, canonical }) => {
      try {
        const c = (await api.get(`/commitments/${commitment}`)) as { anchor_tx?: string; canonical?: string };
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
      description:
        "Whether a Concordium account has passed VeriFlow's zero-knowledge eligibility check (age ≥ 18, not in a restricted " +
        "country)." + (defaultAccount ? " Defaults to this agent's own paying account." : " Pass the account address."),
      inputSchema: {
        account: defaultAccount
          ? z.string().optional().describe("Concordium address; defaults to this agent's paying account")
          : z.string().describe("Concordium account address"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ account }) => {
      try {
        const a = account ?? defaultAccount;
        if (!a) return fail("Pass the Concordium account address to check.");
        const r = (await api.get(`/eligibility/${encodeURIComponent(a)}`)) as { eligible: boolean };
        return json({ account: a, ...r, verify_url: r.eligible ? undefined : `${api.gateway}/verify?account=${a}` });
      } catch (e) {
        return fail(errText(e));
      }
    },
  );
}
