/**
 * MCP tools shared by the local version (stdio, mcp.ts, can pay) and the public version (HTTP, mcp-http.ts, never pays)
 * ------------------------------------------------------------------------------
 * Free tools (both versions): get_track_record, list_commitments, verify_signal, check_eligibility
 * Local only: get_signal (pays) and check_seller (buyer verifies seller before paying) — they need the buyer's own wallet; the public server touches nobody's keys
 */
import { publicMessage } from "./security.js";
import { NET } from "./network.js";
import { ContractAddress } from "@concordium/web-sdk";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readAnchorTx, type OnChainAnchor } from "./anchor.js";
import { registryAddress, TESTNET_REGISTRY_INDEX } from "./contract.js";
import { createGrpc, grpcEndpoint } from "./grpc.js";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { allOk, verifyCommitment } from "./verify.js";
import { AGENT_REGISTRY_TEXT } from "./registry-node.js";

export const EXPLORER = `${NET.explorer}/transaction/`;
export const json = (x: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(x, null, 2) }] });
export const fail = (msg: string) => ({ content: [{ type: "text" as const, text: msg }], isError: true });
/** Error text for a tool result: the public MCP and A2A servers show it to anyone, so no URLs, hosts or paths (security.ts) */
export const errText = (e: unknown) => publicMessage(e);
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export const ABOUT =
  "VeriFlow sells a crypto risk-regime signal (RISK_ON / RISK_OFF for BTC or ETH). Each signal's SHA-256 commitment is " +
  "anchored on Concordium testnet before its 7-day outcome is known, so the track record cannot be edited afterwards. ";

/** How the public endpoints are read (local: GATEWAY_URL; public: itself) */
export type PublicApi = { get: (path: string) => Promise<unknown>; gateway: string };

export const REGISTRY = registryAddress() ?? ContractAddress.create(TESTNET_REGISTRY_INDEX, 0n);
const NODE = grpcEndpoint().join(":");

/**
 * Read an on-chain commitment transaction. Ask a Concordium node directly first; only if that fails (e.g. a network blocking port 20000) fall back to the seller's /onchain, clearly labelled.
 * whoReads: says who is reading — for the local MCP the buyer itself; for the public version VeriFlow's server
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
  /** A just-bought signal's anchor transaction may not be in a block yet: wait up to about 30 seconds */
  return async function readSettled(tx: string) {
    let r = await once(tx, true);
    for (let i = 0; r.onchain.status === "pending" && i < 10; i++) {
      await sleep(3000);
      r = await once(tx, r.direct);
    }
    return r;
  };
}

/** Owner of the v2 contract (cold account 4dNM, also the owner of agent #1313's badge); undefined if it cannot be read */
async function v2Owner(): Promise<string | undefined> {
  try {
    const { createV2Reader, v2Address, TESTNET_REGISTRY_V2_INDEX } = await import("./contract-v2.js");
    return (await createV2Reader(v2Address() ?? ContractAddress.create(TESTNET_REGISTRY_V2_INDEX, 0n)).summary()).owner;
  } catch {
    return undefined;
  }
}

/** The free operations themselves (shared by MCP tools and A2A skills; return plain data, throw on error) */
export function publicOps(api: PublicApi, readSettled: ReturnType<typeof createChainReader>) {
  return {
    trackRecord: () => api.get("/track-record"),
    commitments: () => api.get("/commitments"),
    async eligibility(account: string) {
      const r = (await api.get(`/eligibility/${encodeURIComponent(account)}`)) as { eligible: boolean };
      return { account, ...r, verify_url: r.eligible ? undefined : `${api.gateway}/verify?account=${account}` };
    },
    /** null = this commitment is not on-chain yet */
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
    /** No payment: ask the x402 endpoint whom to pay, how much, and what proof is required */
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
          `Verify the seller: the agent the 402 names in the Concordium Agent Registry (CIS-8004 ${AGENT_REGISTRY_TEXT}) — badge valid, Active, Agent Card hash, and payTo equal to its on-chain agentWallet`,
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

/** The four free tools; defaultAccount: the local version checks its own paying account by default, the public version must be told which */
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
        "Counts from VeriFlow's public record: calls issued, asset-days committed, asset-days with more than one commit (per contract), " +
        "and calls past the 7-day horizon. No hit rate is published: the score comes only from the chain and Binance, by the scoring rule " +
        "registered on-chain before the first contract-v2 call (link in the result). Free.",
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
