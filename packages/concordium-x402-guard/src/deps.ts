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

/** Call one tool of the hosted Agent Registry MCP service (JSON-RPC over HTTP) */
export function registryMcp(url = DEFAULT_REGISTRY_MCP, f: typeof fetch = fetch): RegistryCall {
  return async (name, args) => {
    const res = await f(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await res.text();
    const jsonText = text.trim().startsWith("{") ? text : (text.match(/^data: (.*)$/m)?.[1] ?? text);
    const msg = JSON.parse(jsonText);
    if (msg.error) throw new Error(`${name}: ${JSON.stringify(msg.error)}`);
    const out = (msg.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n");
    if (msg.result?.isError) throw new Error(`${name}: ${out}`);
    try { return JSON.parse(out); } catch { return out; }
  };
}

const TRANSIENT = /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|UNAVAILABLE|DEADLINE_EXCEEDED|deadline|socket hang up|No connection established|\b(429|5\d\d)\b/i;

/** Retry a read on a dropped connection or a 429, three tries in all; anything else is thrown at once */
export async function retrying<T>(f: () => Promise<T>, tries = 3, waitMs = 1500): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= tries || !TRANSIENT.test(e instanceof Error ? `${e.message} ${(e as { code?: unknown }).code ?? ""}` : String(e))) throw e;
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

export function concordiumGuardDeps(o: DepsOptions = {}): GuardDeps {
  const net = NETWORKS[o.network ?? "testnet"];
  let client = o.grpc;
  const grpc = () => (client ??= new ConcordiumGRPCNodeClient(net.grpc.host, net.grpc.port, credentials.createSsl(), { timeout: 20_000 }));
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
    const read = (expectOwner: string) =>
      checkEvmBinding({ address: req.payTo, publicKey: key.publicKey, namespace: req.network, expectOwner }, (k) => retrying(() => ownerOfKey(grpc(), cis8Addr, k)), sameAccount);
    let r = agent.owner ? await read(agent.owner) : { ok: false as const, reason: "agent has no owner on-chain" };
    if (!r.ok && agent.wallet && /is bound to/.test(r.reason)) r = await read(agent.wallet);
    return { name, ok: r.ok, detail: r.ok ? `${req.payTo} is bound to ${r.owner} in CIS-8 ${cis8Text} (key from ${key.from})` : `${r.reason} (key from ${key.from})` };
  };

  return {
    registryNetwork: net.name,
    concordiumNetwork: net.caip2,
    registryAddress: `${net.agentRegistry.index}.${net.agentRegistry.subindex}`,
    registry: (name, args) => retrying(() => call(name, args)),
    readAgent: (id) => retrying(() => readAgent(grpc(), registryAddr, id)),
    evmPayToCheck,
    isEvmNetwork: (n) => n.startsWith("eip155:"),
    fetch: o.fetch,
  };
}
