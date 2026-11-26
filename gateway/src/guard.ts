/**
 * Concordium seller guard for any x402 client
 * -------------------------------------------
 * A drop-in for agents people already run: wrap an existing @x402/fetch client and, before any payment is signed,
 * the seller is checked against Concordium. Nothing about the seller has to be VeriFlow's.
 *
 *   const guarded = protect(client, guardDeps());
 *   const { response, verdict } = await guarded.fetch("https://seller.example/x402/thing", { method: "POST", body });
 *
 * Checks (counterparty.ts does 1–5; this file adds where to look, the EVM variant and an optional third-party record):
 *   1. the site the agent actually requested (never the 402's own resource.url) advertises a Verified by Concordium badge
 *   2. the badge's agent is registered and Active in the CIS-8004 Agent Registry, read from a Concordium node
 *   3. the official badge check passes (the owner is an identity-verified person)
 *   4. the Agent Card's own SHA-256 equals the hash pinned on-chain
 *   5. payTo is that agent's on-chain agentWallet (CCD), or, for an EVM payTo, a key bound to the agent's owner in CIS-8
 *   6. (optional) an independent delivery record: vet402, another team's service, says whether the seller delivered when paid
 *
 * If a check fails the wallet is never asked to sign. Checks 1–5 fail closed: an unreachable node or registry means no payment.
 * Check 6 is a third party's opinion, not chain state, so the policy decides how much it counts (default: only a proven
 * non-delivery, verdict "no", blocks; "unproven" and an unreachable service do not).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { wrapFetchWithPayment, type x402Client } from "@x402/fetch";
import { AGENT_EXTENSION, summarize as summarizeSeller, verifySeller, type RegistryCall, type SellerVerdict } from "./counterparty.js";
import type { AgentOnChain } from "./registry-node.js";
import type { Check } from "./verify.js";

/** The part of an x402 payment option the guard looks at */
export type Requirement = { scheme?: string; network: string; payTo: string; amount?: string; asset?: string; extra?: Record<string, unknown> };
export type PaymentRequiredLike = { extensions?: Record<string, unknown> };

export type ReputationMode = "off" | "advisory" | "block-no" | "require-go";

export type GuardPolicy = {
  /** Pay only sellers whose 402 names their agent (VeriFlow's concordium-agent extension). Off for sellers in the wild */
  requireNamedAgent?: boolean;
  /** How the independent delivery record counts. Default "block-no" */
  reputation?: ReputationMode;
  /** Base URL of the delivery-record service (vet402) */
  reputationUrl?: string;
};

export type GuardDeps = {
  /** Concordium network name for the hosted registry service ("testnet" / "mainnet") */
  registryNetwork: string;
  /** CAIP-2 id of the Concordium network the agent lives on */
  concordiumNetwork: string;
  /** "<index>.<subindex>" of the CIS-8004 registry */
  registryAddress: string;
  registry: RegistryCall;
  readAgent: (tokenId: string) => Promise<AgentOnChain | null>;
  /** EVM payTo: check that it is bound to the agent in CIS-8 (agent.ts supplies a node-backed version) */
  evmPayToCheck?: (req: Requirement) => (agent: { owner?: string; wallet?: string; externalRef?: AgentOnChain["externalRef"] | undefined }) => Promise<Check>;
  isEvmNetwork?: (network: string) => boolean;
  fetch?: typeof fetch;
};

export type GuardVerdict = SellerVerdict & { origin: string; reputation?: { verdict: string; source: string } };

export const DEFAULT_REPUTATION_URL = "https://vet402-concordium.fly.dev";
const REPUTATION_CHECK = "independent delivery record (vet402, another team's service)";

/** What the 402's concordium-agent extension names: "unnamed", "mismatch" (another network or registry), or "<tokenId>|<badge>" */
export function namedAgentOf(pr: PaymentRequiredLike | undefined, network: string, registryAddress: string): string {
  const info = (pr?.extensions?.[AGENT_EXTENSION] as { info?: { network?: string; registry?: string; tokenId?: string; badge?: string } } | undefined)?.info;
  if (!info) return "unnamed";
  if (info.network !== network || info.registry !== registryAddress || !/^\d+$/.test(info.tokenId ?? "")) return "mismatch";
  return `${info.tokenId}|${info.badge ?? ""}`;
}

/** The independent delivery record for an agent. Never throws: an unreachable service is reported as such */
export async function deliveryRecord(tokenId: string, base: string, f: typeof fetch = fetch): Promise<{ verdict: string; detail: string }> {
  try {
    const r = await f(`${base.replace(/\/$/, "")}/check?agent=${encodeURIComponent(tokenId)}`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return { verdict: "unreachable", detail: `HTTP ${r.status}` };
    const j = (await r.json()) as { vet402?: { verdict?: string; reason?: string; N?: number }; trust_summary?: { line?: string } };
    const verdict = typeof j?.vet402?.verdict === "string" ? j.vet402.verdict : "unreadable";
    const why = j?.trust_summary?.line ?? j?.vet402?.reason ?? "";
    return { verdict, detail: `verdict "${verdict}"${typeof j?.vet402?.N === "number" ? ` from ${j.vet402.N} paid request(s)` : ""}${why ? `: ${why}` : ""}` };
  } catch (e) {
    return { verdict: "unreachable", detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Does this record pass under the policy? */
export function reputationPasses(verdict: string, mode: ReputationMode): boolean {
  if (mode === "off" || mode === "advisory") return true;
  if (mode === "require-go") return verdict === "go";
  return verdict !== "no";
}

/**
 * Check the seller behind one payment option. `origin` must be the site the agent itself chose to call:
 * the badge is read from there, and everything else from the chain.
 */
export async function checkSellerFor(
  target: { origin: string; req: Requirement; paymentRequired?: PaymentRequiredLike },
  deps: GuardDeps,
  policy: GuardPolicy = {},
): Promise<GuardVerdict> {
  const { origin, req } = target;
  const evm = deps.isEvmNetwork?.(req.network) ?? req.network.startsWith("eip155:");
  // The agent always lives on Concordium: when paying on EVM, the 402 names it on the Concordium network
  const named = namedAgentOf(target.paymentRequired, evm ? deps.concordiumNetwork : req.network, deps.registryAddress);
  if (named === "mismatch" || (named === "unnamed" && policy.requireNamedAgent)) {
    return {
      origin,
      ok: false,
      payTo: req.payTo,
      checks: [
        {
          name: "402 names an agent on this network's registry",
          ok: false,
          detail: named === "unnamed" ? "the 402 has no concordium-agent extension: the seller does not name itself" : "concordium-agent extension names another network or registry",
        },
      ],
    };
  }
  if (evm && !deps.evmPayToCheck) {
    return { origin, ok: false, payTo: req.payTo, checks: [{ name: "payTo is bound to the agent on-chain", ok: false, detail: `no way to check an EVM payTo on ${req.network}` }] };
  }
  const base = await verifySeller({
    gateway: origin,
    payTo: req.payTo,
    registry: deps.registry,
    network: deps.registryNetwork,
    readAgent: deps.readAgent,
    fetch: deps.fetch,
    expectTokenId: named.includes("|") ? named.split("|")[0] : undefined,
    expectBadge: named.includes("|") ? named.split("|")[1] || undefined : undefined,
    payToCheck: evm ? deps.evmPayToCheck!(req) : undefined,
  });
  const out: GuardVerdict = { ...base, origin };
  // vet402 records testnet only: on another network its answer would be about a different agent with the same number
  const mode = policy.reputation ?? (deps.registryNetwork === "testnet" ? "block-no" : "off");
  // Only ask the third party about a seller that already passed the chain checks
  if (mode === "off" || !base.ok || !base.tokenId) return out;
  const src = policy.reputationUrl ?? DEFAULT_REPUTATION_URL;
  const rec = await deliveryRecord(base.tokenId, src, deps.fetch);
  const pass = reputationPasses(rec.verdict, mode);
  out.reputation = { verdict: rec.verdict, source: src };
  out.checks = [...base.checks, { name: `${REPUTATION_CHECK}${mode === "advisory" ? ", advisory" : ""}`, ok: pass, detail: `${rec.detail} (policy ${mode})` }];
  out.ok = base.ok && pass;
  return out;
}

export function summarize(v: GuardVerdict): string {
  const s = summarizeSeller(v);
  if (!v.ok && v.checks.slice(0, 5).every((c) => c.ok)) {
    const rep = v.checks[5];
    return `refused to pay: ${rep?.name} — ${rep?.detail}`;
  }
  return v.reputation && v.ok ? `${s}; delivery record: ${v.reputation.verdict}` : s;
}

/**
 * Wrap an x402 client: every payment it would make through the returned fetch is checked first.
 * Payments attempted outside the guarded fetch (no known origin) are refused.
 */
export function protect(client: x402Client, deps: GuardDeps, policy: GuardPolicy = {}, onVerdict?: (v: GuardVerdict) => void) {
  const als = new AsyncLocalStorage<{ origin: string; verdict?: GuardVerdict }>();
  client.onBeforePaymentCreation(async ({ selectedRequirements, paymentRequired }) => {
    const store = als.getStore();
    if (!store) return { abort: true as const, reason: "seller guard: payment requested outside a guarded request" };
    store.verdict = await checkSellerFor({ origin: store.origin, req: selectedRequirements as Requirement, paymentRequired }, deps, policy);
    onVerdict?.(store.verdict);
    if (!store.verdict.ok) return { abort: true as const, reason: summarize(store.verdict) };
  });
  const paying = wrapFetchWithPayment(deps.fetch ?? fetch, client);
  return {
    /** fetch that pays only checked sellers. Returns the response (if any), the verdict (if a payment was needed) and the error (if any) */
    async fetch(url: string, init?: RequestInit): Promise<{ response?: Response; verdict?: GuardVerdict; error?: unknown }> {
      const store: { origin: string; verdict?: GuardVerdict } = { origin: new URL(url).origin };
      try {
        const response = await als.run(store, () => paying(url, init));
        return { response, verdict: store.verdict };
      } catch (error) {
        return { verdict: store.verdict, error };
      }
    },
  };
}
