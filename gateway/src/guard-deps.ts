/**
 * The guard's Concordium connections for this repo: hosted registry service (to resolve a badge to a token id),
 * a Concordium node (the agent record itself) and CIS-8 for EVM payouts.
 */
import { AGENT_REGISTRY, readAgent, type AgentOnChain } from "./registry-node.js";
import { checkEvmBinding, EVM_KEY_TYPE, CIS8_REGISTRY } from "./cis8.js";
import { isEvmNetwork } from "./evm-payer.js";
import { sameAccount } from "./contract-v2.js";
import { NETWORK } from "./config.js";
import { NET } from "./network.js";
import { isTransient } from "./grpc.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { REGISTRY_NETWORK, registryTool } from "./registry.js";
import type { GuardDeps, Requirement } from "./guard.js";

/**
 * EVM payTo: the 402's extra.cis8 gives the seller's public key. Read CIS-8 from a Concordium node and require
 * the address derived from the key to equal payTo, the binding to be Active, and its owner to be the agent's owner (or its agentWallet)
 */
/** secp256k1 public key → 65-byte uncompressed hex (accepts 33-byte compressed or 65-byte uncompressed, with or without 0x) */
export function uncompressed(hex: string): string {
  const h = hex.replace(/^0x/i, "").toLowerCase();
  return Buffer.from(secp256k1.ProjectivePoint.fromHex(h).toRawBytes(false)).toString("hex");
}

/**
 * Whom a CIS-8 binding may name: the agent's owner, or its agentWallet (the payout account the owner set on-chain;
 * an operator may keep its EVM key under that account). Anything else is refused. Alias-aware.
 */
export function boundAs(bound: string, agent: { owner?: string; wallet?: string }): "owner" | "agentWallet" | undefined {
  const same = (a: string, b: string) => { try { return sameAccount(a, b); } catch { return false; } };
  if (agent.owner && same(bound, agent.owner)) return "owner";
  if (agent.wallet && same(bound, agent.wallet)) return "agentWallet";
  return undefined;
}

export const cis8PayTo = (req: Requirement) => async (agent: { owner?: string; wallet?: string; externalRef?: AgentOnChain["externalRef"] }) => {
  const name = "payTo is bound to the agent in CIS-8 (read from a Concordium node)";
  const cis8Text = `${CIS8_REGISTRY.index}.${CIS8_REGISTRY.subindex}`;
  // Where the key comes from: the 402's extra.cis8 (VeriFlow's sellers), or else the agent's own on-chain external_reference
  // (any seller that linked its EVM key in the Agent Registry, e.g. x402 Doctor on mainnet)
  const c = req.extra?.cis8 as { registry?: string; namespace?: string; keyType?: string; publicKey?: string } | undefined;
  let key: { publicKey: string; keyType: string; from: string };
  if (c?.publicKey) {
    if (c.registry !== cis8Text || c.namespace !== req.network || c.keyType !== EVM_KEY_TYPE)
      return { name, ok: false, detail: `unexpected cis8 registry/namespace/key type: ${c.registry} ${c.namespace} ${c.keyType}` };
    key = { publicKey: c.publicKey, keyType: EVM_KEY_TYPE, from: "the 402's extra.cis8" };
  } else {
    const r = agent.externalRef;
    if (r === undefined) return { name, ok: false, detail: "the 402 names no CIS-8 key, and the agent's external_reference could not be read (no answer from a Concordium node)" };
    if (!r) return { name, ok: false, detail: "the 402 names no CIS-8 key and the agent has no external_reference on-chain" };
    if (r.contract !== `<${CIS8_REGISTRY.index},${CIS8_REGISTRY.subindex}>` || r.namespace !== req.network || r.keyType !== EVM_KEY_TYPE)
      return { name, ok: false, detail: `the agent's external_reference is ${r.namespace} ${r.keyType} in ${r.contract}, not an EVM key for ${req.network} in CIS-8 <${CIS8_REGISTRY.index},${CIS8_REGISTRY.subindex}>` };
    // The registry may hold the key compressed (33 bytes); the address is derived from the uncompressed form
    let pk: string;
    try { pk = uncompressed(r.publicKey); } catch (e) { return { name, ok: false, detail: `the agent's external key is not a valid secp256k1 point: ${e instanceof Error ? e.message : e}` }; }
    key = { publicKey: pk, keyType: EVM_KEY_TYPE, from: "the agent's on-chain external_reference" };
  }
  // Who is the key bound to? Then require that account to be the agent's owner, or its agentWallet; compared in code
  const r = await checkEvmBinding({ address: req.payTo, publicKey: key.publicKey, namespace: req.network, keyType: key.keyType }, sameAccount);
  if (!r.ok) return { name, ok: false, detail: `${r.reason} (key from ${key.from})` };
  const as = boundAs(r.owner, agent);
  if (!as) return { name, ok: false, detail: `${req.payTo} is bound to ${r.owner}, which is neither the agent's owner ${agent.owner ?? "(none)"} nor its agentWallet ${agent.wallet ?? "(none)"} (key from ${key.from})` };
  return { name, ok: true, detail: `${req.payTo} is bound to ${r.owner} (the agent's ${as}) in CIS-8 <${CIS8_REGISTRY.index},${CIS8_REGISTRY.subindex}> (key from ${key.from})` };
};

/**
 * Public nodes sometimes drop a connection or rate-limit a burst. Try three times with a fresh connection before giving up;
 * after that the guard still fails closed (no node answer, no payment)
 */
export function readAgentRetrying(id: string, tries = 3, read: (id: string) => Promise<AgentOnChain | null> = (i) => readAgent(i)): Promise<AgentOnChain | null> {
  return retrying(() => read(id), tries);
}

/** Transient: a gRPC/socket failure (also when Node's fetch hides it in error.cause), a timeout, or an HTTP 429/5xx */
export function transient(e: unknown): boolean {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let d = 0; cur && d < 4; d++) {
    if (isTransient(cur)) return true;
    if (cur instanceof Error) parts.push(cur.name, cur.message);
    else parts.push(String(cur));
    const c = (cur as { code?: unknown; status?: unknown }).code;
    if (c !== undefined) parts.push(String(c));
    cur = (cur as { cause?: unknown }).cause;
  }
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR_\w+|socket hang up|No connection established|aborted due to timeout|TimeoutError|^HTTP (429|5\d\d)$|\bHTTP (429|5\d\d)\b/i.test(parts.join(" "));
}

export async function retrying<T>(f: () => Promise<T>, tries = 3, waitMs = 1500): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= tries || !transient(e)) throw e;
      await new Promise((r) => setTimeout(r, waitMs * i));
    }
  }
}

export function guardDeps(): GuardDeps {
  return {
    registryNetwork: REGISTRY_NETWORK,
    concordiumNetwork: NETWORK,
    registryAddress: `${AGENT_REGISTRY.index}.${AGENT_REGISTRY.subindex}`,
    // The hosted service reads its own node and can pass on a 429: retry it the same way
    registry: (name, args) => retrying(() => registryTool(name, args)),
    readAgent: (id) => readAgentRetrying(id),
    evmPayToCheck: cis8PayTo,
    isEvmNetwork,
    evmNetworks: [NET.evm.network],
    // Tests run a local Agent Card server on http://127.0.0.1; a real deployment never sets this variable
    allowLocalHttpCards: !!process.env.VERIFLOW_TEST_AGENT_RECORD,
  };
}
