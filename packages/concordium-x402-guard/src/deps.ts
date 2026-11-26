/**
 * Everything the guard reads, wired for one Concordium network:
 *   - the hosted Agent Registry MCP service, only to turn a badge into a token id (and for the official badge check)
 *   - a Concordium node, for the agent record itself and for CIS-8
 */
import { ContractAddress, type ConcordiumGRPCClient } from "@concordium/web-sdk";
import { ConcordiumGRPCNodeClient, credentials } from "@concordium/web-sdk/nodejs";
import { NETWORKS, type NetworkName } from "./networks.js";
import { readAgent, sameAccount, type AgentOnChain } from "./agent-record.js";
import { checkEvmBinding, ownerOfKey, uncompressed, EVM_KEY_TYPE } from "./cis8.js";
import type { GuardDeps, Requirement } from "./guard.js";
import type { Check, RegistryCall } from "./seller.js";

export const DEFAULT_REGISTRY_MCP = "https://agent-registry-mcp.concordium.com/mcp";

/** Read a response body, refusing more than `max` bytes */
async function textCapped(res: Response, max = 256 * 1024): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { await reader.cancel().catch(() => {}); throw new Error(`registry response over ${max} bytes`); }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

/** Call one tool of the hosted Agent Registry MCP service (JSON-RPC over HTTP). No redirects, a capped body, HTTP 429/5xx thrown as such */
export function registryMcp(url = DEFAULT_REGISTRY_MCP, f: typeof fetch = fetch): RegistryCall {
  return async (name, args) => {
    const res = await f(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    });
    if (res.status === 429 || res.status >= 500) { await res.body?.cancel().catch(() => {}); throw new HttpStatusError(res.status); }
    if (!res.ok) { await res.body?.cancel().catch(() => {}); throw new Error(`${name}: registry answered HTTP ${res.status}`); }
    const text = await textCapped(res);
    const jsonText = text.trim().startsWith("{") ? text : (text.match(/^data: (.*)$/m)?.[1] ?? text);
    const msg = JSON.parse(jsonText);
    if (msg.error) throw new Error(`${name}: ${JSON.stringify(msg.error)}`);
    const out = (msg.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n");
    if (msg.result?.isError) throw new Error(`${name}: ${out}`);
    try { return JSON.parse(out); } catch { return out; }
  };
}

/** A retryable HTTP answer (429 or 5xx) */
export class HttpStatusError extends Error {
  constructor(readonly status: number) { super(`HTTP ${status}`); }
}

/** Socket and gRPC failures that are worth another try. Matched on the error's code and message and on its cause (Node's fetch puts ECONNREFUSED etc. there) */
const TRANSIENT_TEXT = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|UND_ERR_\w+|UNAVAILABLE|DEADLINE_EXCEEDED|deadline|socket hang up|No connection established|aborted due to timeout|TimeoutError/i;

export function isTransient(e: unknown): boolean {
  if (e instanceof HttpStatusError) return true;
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur && depth < 4; depth++) {
    if (cur instanceof Error) parts.push(cur.name, cur.message);
    else parts.push(String(cur));
    const c = (cur as { code?: unknown }).code;
    if (c !== undefined) parts.push(String(c));
    // gRPC status 14 = UNAVAILABLE, 4 = DEADLINE_EXCEEDED
    if (c === 14 || c === 4) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return TRANSIENT_TEXT.test(parts.join(" "));
}

/** Retry a read on a dropped connection, a timeout, a 429 or a 5xx, three tries in all; anything else is thrown at once. `onTransient` runs before each retry (e.g. to drop a dead connection) */
export async function retrying<T>(f: () => Promise<T>, tries = 3, waitMs = 1500, onTransient?: () => void): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= tries || !isTransient(e)) throw e;
      onTransient?.();
      await new Promise((r) => setTimeout(r, waitMs * i));
    }
  }
}

export type DepsOptions = {
  network?: NetworkName;
  /** Your own node client; default: Concordium's public node for the network */
  grpc?: ConcordiumGRPCClient;
  registryMcpUrl?: string;
  fetch?: typeof fetch;
};

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

export function concordiumGuardDeps(o: DepsOptions = {}): GuardDeps {
  const name = o.network ?? "testnet";
  if (!Object.prototype.hasOwnProperty.call(NETWORKS, name))
    throw new Error(`concordiumGuardDeps: network must be "testnet" or "mainnet", got ${JSON.stringify(name)} (this is the Concordium network the checks read, not an x402 network id)`);
  const net = NETWORKS[name as NetworkName];
  let client = o.grpc;
  const grpc = () => (client ??= new ConcordiumGRPCNodeClient(net.grpc.host, net.grpc.port, credentials.createSsl(), { timeout: 20_000 }));
  // A dead channel is not dialed again: after a transient error the next try gets a new client (unless you passed your own)
  const resetGrpc = () => { if (!o.grpc) client = undefined; };
  const registryAddr = ContractAddress.create(net.agentRegistry.index, net.agentRegistry.subindex);
  const cis8Addr = ContractAddress.create(net.cis8Registry.index, net.cis8Registry.subindex);
  const cis8Text = `<${net.cis8Registry.index},${net.cis8Registry.subindex}>`;
  const call = registryMcp(o.registryMcpUrl, o.fetch);

  /** EVM payTo: a key from the 402's extra.cis8, or else the agent's own external_reference, bound in CIS-8 to the agent's owner */
  const evmPayToCheck = (req: Requirement) => async (agent: { owner?: string; wallet?: string; externalRef?: AgentOnChain["externalRef"] | undefined }): Promise<Check> => {
    const name = "payTo is bound to the agent in CIS-8 (read from a Concordium node)";
    const c = req.extra?.cis8 as { registry?: string; namespace?: string; keyType?: string; publicKey?: string } | undefined;
    let key: { publicKey: string; from: string };
    if (c?.publicKey) {
      if (c.registry !== `${net.cis8Registry.index}.${net.cis8Registry.subindex}` || c.namespace !== req.network || c.keyType !== EVM_KEY_TYPE)
        return { name, ok: false, detail: `unexpected cis8 registry/namespace/key type: ${c.registry} ${c.namespace} ${c.keyType}` };
      key = { publicKey: c.publicKey, from: "the 402's extra.cis8" };
    } else {
      const r = agent.externalRef;
      if (r === undefined) return { name, ok: false, detail: "the 402 names no CIS-8 key, and the agent's external_reference could not be read (no answer from a Concordium node)" };
      if (!r) return { name, ok: false, detail: "the 402 names no CIS-8 key and the agent has no external_reference on-chain" };
      if (r.contract !== cis8Text || r.namespace !== req.network || r.keyType !== EVM_KEY_TYPE)
        return { name, ok: false, detail: `the agent's external_reference is ${r.namespace} ${r.keyType} in ${r.contract}, not an EVM key for ${req.network} in CIS-8 ${cis8Text}` };
      try { key = { publicKey: uncompressed(r.publicKey).toString("hex"), from: "the agent's on-chain external_reference" }; } catch (e) {
        return { name, ok: false, detail: `the agent's external key is not a valid secp256k1 point: ${e instanceof Error ? e.message : e}` };
      }
    }
    // Read who the key is bound to, then require that account to be the agent's owner, or its agentWallet (the account the agent
    // is paid into, which the owner set on-chain). Compared in code, never by matching an error message
    const r = await checkEvmBinding({ address: req.payTo, publicKey: key.publicKey, namespace: req.network }, (k) => retrying(() => ownerOfKey(grpc(), cis8Addr, k), 3, 1500, resetGrpc), sameAccount);
    if (!r.ok) return { name, ok: false, detail: `${r.reason} (key from ${key.from})` };
    const as = boundAs(r.owner, agent);
    if (!as) return { name, ok: false, detail: `${req.payTo} is bound to ${r.owner}, which is neither the agent's owner ${agent.owner ?? "(none)"} nor its agentWallet ${agent.wallet ?? "(none)"} (key from ${key.from})` };
    return { name, ok: true, detail: `${req.payTo} is bound to ${r.owner} (the agent's ${as}) in CIS-8 ${cis8Text} (key from ${key.from})` };
  };

  return {
    registryNetwork: net.name,
    concordiumNetwork: net.caip2,
    registryAddress: `${net.agentRegistry.index}.${net.agentRegistry.subindex}`,
    registry: (tool, args) => retrying(() => call(tool, args)),
    readAgent: (id) => retrying(() => readAgent(grpc(), registryAddr, id), 3, 1500, resetGrpc),
    evmPayToCheck,
    isEvmNetwork: (n) => n.startsWith("eip155:"),
    evmNetworks: [net.evmNetwork],
    fetch: o.fetch,
  };
}
