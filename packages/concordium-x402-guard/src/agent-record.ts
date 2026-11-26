/** CIS-8004 agent records, read straight from a Concordium node */
import { AccountAddress, ContractAddress, Parameter, ReceiveName, ReturnValue } from "@concordium/web-sdk";
import type { ConcordiumGRPCClient } from "@concordium/web-sdk";

export type AgentOnChain = {
  tokenId: string;
  owner: string;
  agentUri: string | null;
  metadataHash: string | null;
  wallet: string | null;
  status: "Active" | "Revoked";
  /** CIS-8004 external_reference: kind 0 = an external key in a CIS-8 contract */
  externalRef?: { contract: string; namespace: string; keyType: string; publicKey: string } | null;
};

/** A CIS-8004 token id: one length byte (8), then a u64 little-endian */
export function encodeAgentTokenId(id: bigint): Buffer {
  const b = Buffer.alloc(9);
  b[0] = 8;
  b.writeBigUInt64LE(id, 1);
  return b;
}

/** Strict decoder of CIS-8004.agentOf: anything unexpected throws, so a buyer refuses to pay */
export function decodeAgentOf(buf: Buffer): AgentOnChain | null {
  let o = 0;
  const u8 = () => { if (o + 1 > buf.length) throw new Error("agentOf: truncated"); return buf.readUInt8(o++); };
  const bytes = (n: number) => { if (o + n > buf.length) throw new Error("agentOf: truncated"); const v = buf.subarray(o, o + n); o += n; return v; };
  const account = () => AccountAddress.toBase58(AccountAddress.fromBuffer(new Uint8Array(bytes(32)).buffer as ArrayBuffer));
  const opt = (what: string) => { const t = u8(); if (t > 1) throw new Error(`agentOf: illegal option tag ${t} for ${what}`); return t === 1; };
  const str = () => { if (o + 4 > buf.length) throw new Error("agentOf: truncated"); const n = buf.readUInt32LE(o); o += 4; if (n > 4096) throw new Error("agentOf: field too long"); return bytes(n); };
  if (!opt("record")) return null;
  const idLen = u8();
  if (idLen !== 8) throw new Error(`agentOf: token id length ${idLen}, expected 8`);
  const tokenId = bytes(8).readBigUInt64LE(0).toString();
  const owner = account();
  const agentUri = opt("agent_uri") ? (() => { if (o + 4 > buf.length) throw new Error("agentOf: truncated"); const n = buf.readUInt32LE(o); o += 4; return bytes(n).toString("utf8"); })() : null;
  const metadataHash = opt("metadata_hash") ? bytes(32).toString("hex") : null;
  let externalRef: AgentOnChain["externalRef"] = null;
  if (opt("external_reference")) {
    const c = bytes(16);
    const contract = `<${c.readBigUInt64LE(0)},${c.readBigUInt64LE(8)}>`;
    const kind = u8();
    if (kind !== 0) throw new Error(`agentOf: unknown external_reference kind ${kind}`);
    externalRef = { contract, namespace: str().toString("utf8"), keyType: str().toString("utf8"), publicKey: str().toString("hex") };
  }
  const wallet = opt("agent_wallet") ? account() : null;
  const tag = u8();
  if (tag > 1) throw new Error(`agentOf: unknown status tag ${tag}`);
  return { tokenId, owner, agentUri, metadataHash, wallet, status: tag === 0 ? "Active" : "Revoked", ...(externalRef ? { externalRef } : {}) };
}

/** Read one agent; null if it does not exist, throws if the node cannot be reached */
export async function readAgent(grpc: ConcordiumGRPCClient, registry: ContractAddress.Type, tokenId: string): Promise<AgentOnChain | null> {
  if (!/^\d+$/.test(tokenId)) throw new Error(`bad token id ${tokenId}`);
  const res = await grpc.invokeContract({
    contract: registry,
    method: ReceiveName.fromString("CIS-8004.agentOf"),
    parameter: Parameter.fromBuffer(new Uint8Array(encodeAgentTokenId(BigInt(tokenId))).buffer as ArrayBuffer),
  });
  if (res.tag !== "success" || !res.returnValue) throw new Error(`CIS-8004.agentOf failed (${res.tag})`);
  const a = decodeAgentOf(Buffer.from(ReturnValue.toHexString(res.returnValue), "hex"));
  if (a && a.tokenId !== tokenId) throw new Error(`agentOf(${tokenId}) returned agent #${a.tokenId}`);
  return a;
}

/** Same Concordium account: aliases share the first 29 bytes */
export const sameAccount = (a: string, b: string) =>
  Buffer.from(AccountAddress.fromBase58(a).decodedAddress).subarray(0, 29).equals(Buffer.from(AccountAddress.fromBase58(b).decodedAddress).subarray(0, 29));
