/**
 * concordiumSeller(server, options): attach Concordium's seller-side checks to an x402 resource server
 * -------------------------------------------------------------------------------------------------
 *   before verify   (1) the buyer's Verify & Access proof is re-checked against the chain for THIS payment (if you pass `eligibility`)
 *                   (2) a buyer agent named in X-Concordium-Agent must be Active in the CIS-8004 registry with the payer as its agentWallet
 *   before settle   (2) again, read fresh from a node: an agent revoked or re-pointed in between is refused before the money moves
 *   settle failed   the reported transaction is read from a node; delivered only on an exact on-chain match, and only once
 *   after settle    each settlement transaction is delivered against once (see ledger.ts)
 * Only payments on this Concordium network (CCD or a PLT) are touched; other networks' payments pass through unchanged.
 */
import { ContractAddress, type ConcordiumGRPCClient } from "@concordium/web-sdk";
import { ConcordiumGRPCNodeClient, credentials } from "@concordium/web-sdk/nodejs";
import { AfterSettleAbortError } from "@x402/core/server";
import { readAgent, retrying, type AgentOnChain } from "concordium-x402-guard";
import { BUYER_AGENT_HEADER, checkBuyerAgent, type BuyerAgentPolicy } from "./buyer-agent.js";
import { memoryLedger, type PaymentLedger } from "./ledger.js";
import { network as networkOf, type NetworkName, type SellerNetwork } from "./networks.js";
import { payerOf } from "./payer.js";
import { paidOnChain } from "./recovery.js";

type Abort = { abort: true; reason: string; message?: string };
type Ctx = { paymentPayload: { payload: unknown }; requirements: { network: string; payTo: string; amount: string; asset: string }; transportContext?: unknown };

/** The hooks this needs from an x402ResourceServer (any @x402/core 2.x build) */
export type SellerServer = {
  onBeforeVerify(h: (ctx: any) => Promise<void | Abort>): unknown;
  onBeforeSettle(h: (ctx: any) => Promise<void | Abort>): unknown;
  onSettleFailure(h: (ctx: any) => Promise<void | { recovered: true; result: unknown }>): unknown;
  onAfterSettle(h: (ctx: any) => Promise<void>): unknown;
};

export type SellerOptions = {
  network?: NetworkName;
  /** Your node client; default: Concordium's public node for the network */
  grpc?: ConcordiumGRPCClient;
  /** Re-check the buyer's proof at every payment: an EligibilityService (or anything with recheck(account) that throws when not eligible) */
  eligibility?: { recheck(account: string): Promise<unknown> };
  /** Where a refused buyer can prove eligibility (shown in the refusal) */
  verifyUrl?: string;
  /** Buyer agents named in X-Concordium-Agent: "off", "optional" (default: check when named) or "required" */
  buyerAgent?: BuyerAgentPolicy;
  /** Recover settlements a facilitator reports as failed by reading the chain (default true) */
  recover?: boolean;
  ledger?: PaymentLedger;
  log?: (msg: string) => void;
  /** Override how an agent record is read (default: CIS-8004 agentOf from the node, retried) */
  readAgent?: (tokenId: string) => Promise<AgentOnChain | null>;
};

/** The request header, from any x402 HTTP adapter (Express, Hono, Next) */
function headerOf(transportContext: unknown, name: string): string | undefined {
  const a = (transportContext as { request?: { adapter?: { getHeader?: (n: string) => string | undefined } } } | undefined)?.request?.adapter;
  try { return a?.getHeader?.(name) ?? undefined; } catch { return undefined; }
}

export function concordiumSeller<S extends SellerServer>(server: S, o: SellerOptions = {}): S {
  const net: SellerNetwork = networkOf(o.network);
  let client = o.grpc;
  const grpc = () => (client ??= new ConcordiumGRPCNodeClient(net.grpc.host, net.grpc.port, credentials.createSsl(), { timeout: 20_000 }));
  const resetGrpc = () => { if (!o.grpc) client = undefined; };
  const registry = ContractAddress.create(net.agentRegistry.index, net.agentRegistry.subindex);
  const read = o.readAgent ?? ((id: string): Promise<AgentOnChain | null> => retrying(() => readAgent(grpc(), registry, id), 3, 1500, resetGrpc));
  const policy = o.buyerAgent ?? "optional";
  const ledger = o.ledger ?? memoryLedger();
  const log = o.log ?? ((m: string) => console.log(m));
  const ours = (r: Ctx["requirements"]) => r.network === net.caip2;

  const agentCheck = async (ctx: Ctx, when: string): Promise<void | Abort> => {
    const payer = payerOf(ctx.paymentPayload.payload);
    const r = await checkBuyerAgent(headerOf(ctx.transportContext, BUYER_AGENT_HEADER), payer, policy, read);
    if (!r.ok) {
      log(`refused ${when}, buyer agent: ${r.reason}`);
      return { abort: true, reason: `buyer_agent_check_failed:${r.code}`, message: r.reason };
    }
  };

  server.onBeforeVerify(async (ctx: Ctx) => {
    if (!ours(ctx.requirements)) return;
    const payer = payerOf(ctx.paymentPayload.payload);
    if (!payer) return { abort: true, reason: "no_payer", message: "the payment names no Concordium sender" };
    if (o.eligibility) {
      try {
        await o.eligibility.recheck(payer);
      } catch (e) {
        log(`refused buyer ${payer}: ${e instanceof Error ? e.message : e}`);
        return { abort: true, reason: "buyer_proof_required", message: `Account ${payer} has no current eligibility proof that passes the check at payment time.${o.verifyUrl ? ` Verify at ${o.verifyUrl}` : ""}` };
      }
    }
    return agentCheck(ctx, "before verification");
  });

  server.onBeforeSettle(async (ctx: Ctx) => {
    if (!ours(ctx.requirements)) return;
    return agentCheck(ctx, "before settlement");
  });

  server.onSettleFailure(async (ctx: Ctx & { error: unknown }) => {
    if (o.recover === false || !ours(ctx.requirements)) return;
    const e = ctx.error as { transaction?: string; errorReason?: string; message?: string };
    const payer = payerOf(ctx.paymentPayload.payload);
    log(`settlement reported failure: ${e?.errorReason ?? e?.message ?? "?"} tx=${e?.transaction || "-"}`);
    if (!e?.transaction || !payer) return;
    const { payTo, amount, asset } = ctx.requirements;
    const paid = await paidOnChain(grpc(), e.transaction, payer, payTo, amount, asset);
    if (!paid.ok) { log(`not recovered: ${paid.why}`); return; }
    if (!(await ledger.claim(e.transaction).catch(() => false))) { log(`not recovered: ${e.transaction} was already delivered against`); return; }
    log(`recovered: ${e.transaction} is finalized and pays ${amount} ${asset} to ${payTo}`);
    return { recovered: true as const, result: { success: true, transaction: e.transaction, network: ctx.requirements.network, payer } };
  });

  server.onAfterSettle(async (ctx: { result: { transaction?: string } }) => {
    const tx = ctx.result?.transaction;
    if (!tx) return;
    let first: boolean;
    // The money has moved: if the ledger is down, deliver (it only stops duplicates)
    try { first = await ledger.claim(tx); } catch (err) { log(`payment ledger unavailable, delivering ${tx}: ${err instanceof Error ? err.message : err}`); return; }
    if (!first) throw new AfterSettleAbortError("already_delivered", "this payment was already delivered");
  });

  return server;
}

/**
 * The 402's `concordium-agent` extension: names the CIS-8004 agent being paid, so a buyer's guard (concordium-x402-guard) checks
 * exactly that agent. No wallet in it: the buyer reads agentWallet from the chain and compares it with payTo.
 */
export function sellerAgentExtension(o: { network?: NetworkName; tokenId: string | number; badge?: string }) {
  const net = networkOf(o.network);
  return {
    "concordium-agent": {
      info: { network: net.caip2, registry: `${net.agentRegistry.index}.${net.agentRegistry.subindex}`, tokenId: String(o.tokenId), ...(o.badge ? { badge: o.badge } : {}) },
    },
  };
}
