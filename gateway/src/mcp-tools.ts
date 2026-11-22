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
import { decodePaymentRequiredHeader } from "@x402/core/http";
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

/** v2 合約的擁有者（冷帳號 4dNM，也是 Agent #1313 徽章擁有者）；讀不到就回 undefined */
async function v2Owner(): Promise<string | undefined> {
  try {
    const { createV2Reader, v2Address, TESTNET_REGISTRY_V2_INDEX } = await import("./contract-v2.js");
    return (await createV2Reader(v2Address() ?? ContractAddress.create(TESTNET_REGISTRY_V2_INDEX, 0n)).summary()).owner;
  } catch {
    return undefined;
  }
}

/** 免費操作本身（MCP 工具與 A2A 技能共用；回傳純資料，錯誤丟例外） */
export function publicOps(api: PublicApi, readSettled: ReturnType<typeof createChainReader>) {
  return {
    trackRecord: () => api.get("/track-record"),
    commitments: () => api.get("/commitments"),
    async eligibility(account: string) {
      const r = (await api.get(`/eligibility/${encodeURIComponent(account)}`)) as { eligible: boolean };
      return { account, ...r, verify_url: r.eligible ? undefined : `${api.gateway}/verify?account=${account}` };
    },
    /** 回傳 null＝這個承諾還沒上鏈 */
    async verifySignal(commitment: string, canonical?: string) {
      const c = (await api.get(`/commitments/${commitment}`)) as { anchor_tx?: string; canonical?: string };
      if (!c.anchor_tx) return null;
      const { onchain, source } = await readSettled(c.anchor_tx);
      const content = canonical ?? c.canonical;
      const checks = verifyCommitment(commitment, onchain, content);
      return {
        verified: allOk(checks),
        checks,
        anchor_tx: c.anchor_tx,
        anchor_explorer: EXPLORER + c.anchor_tx,
        anchored_at: onchain.block_time ?? undefined,
        read_from: source,
        anchor_contract: onchain.contract ?? `<${REGISTRY.index},${REGISTRY.subindex}> (v1)`,
        ...(onchain.contract ? { contract_owner: await v2Owner(), contract_rule: "one call per asset and day; only the owner's appointed committer can commit" } : {}),
        content_checked: content !== undefined,
        note:
          onchain.status === "pending"
            ? "The anchor transaction is not in a block yet; try again in a minute."
            : content === undefined
              ? "Signal content is revealed after the 7-day horizon; only the on-chain anchor was checked."
              : undefined,
      };
    },
    /** 不付款：問 x402 端點要付給誰、多少、需要什麼證明 */
    async howToBuy(signalBaseUrl: string) {
      const r = await fetch(`${signalBaseUrl}/signal/BTC`);
      const header = r.headers.get("PAYMENT-REQUIRED");
      if (r.status !== 402 || !header) throw new Error(`expected an x402 402 response, got HTTP ${r.status}`);
      return {
        endpoint: `${api.gateway}/signal/{BTC|ETH}`,
        protocol: "x402 v2, Concordium exact scheme, fees sponsored by VeriFlow's facilitator",
        accepts: decodePaymentRequiredHeader(header).accepts,
        before_paying: [
          `The paying account's owner proves once, with the Concordium wallet, age >= 18 and not resident in a restricted country: ${api.gateway}/verify`,
          "Verify the seller: agent #1313 in the Concordium Agent Registry (CIS-8004 <12802,0>) — badge valid, Active, Agent Card hash, and payTo equal to its on-chain agentWallet",
        ],
        buy_with: [
          "VeriFlow's local MCP server (pays from your own key, verifies the seller first): git clone https://github.com/jiahaoc040-ai/veriflow && cd veriflow/gateway && npm ci && npm run mcp:config -- --install",
          "Any x402 client with the @x402/concordium exact scheme",
        ],
        after_paying: "Verify with the returned commitment and canonical string (MCP verify_signal or the A2A verify skill).",
      };
    },
  };
}

/** 四個免費工具；defaultAccount：本機版預設查自己的付款帳號，公開版必須指定 */
export function registerPublicTools(
  server: McpServer,
  api: PublicApi,
  readSettled: ReturnType<typeof createChainReader>,
  defaultAccount?: string,
) {
  const ops = publicOps(api, readSettled);
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
        return json(await ops.trackRecord());
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
        return json(await ops.commitments());
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
        const v = await ops.verifySignal(commitment, canonical);
        return v ? json(v) : fail("This commitment exists but has not been anchored on-chain.");
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
        return json(await ops.eligibility(a));
      } catch (e) {
        return fail(errText(e));
      }
    },
  );
}
