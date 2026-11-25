/**
 * Read the Agent Registry (CIS-8004 <12802,0>) straight from a Concordium node, not through the hosted query service
 * -------------------------------------------------------------------------------
 * CIS-8004.agentOf(token id) returns Option<agent record>, fields in order:
 *   token_id ByteList(U8) · owner_account 32 bytes · agent_uri Option<String U32> · metadata_hash Option<32 bytes>
 *   · external_reference Option<…> · agent_wallet Option<AccountAddress> · status enum(Active=0, Revoked=1)
 *   · registered_at u64 · revoked_at Option<u64> · revocation_reason Option<String> · on_chain_metadata …
 * We read up to status; later fields are not parsed.
 */
import "./env-file.js";
import { AccountAddress, ContractAddress, Parameter, ReceiveName, ReturnValue } from "@concordium/web-sdk";
import { createGrpc } from "./grpc.js";
import { NET } from "./network.js";

export const AGENT_REGISTRY = ContractAddress.create(NET.agentRegistry.index, NET.agentRegistry.subindex);
export const AGENT_REGISTRY_TEXT = `<${AGENT_REGISTRY.index},${AGENT_REGISTRY.subindex}>`;

export type AgentOnChain = {
  tokenId: string;
  owner: string;
  agentUri: string | null;
  metadataHash: string | null;
  wallet: string | null;
  status: "Active" | "Revoked";
  /** CIS-8004 external_reference: only one kind is defined so far (tag 0 = CIS-8), pointing at an external key in a CIS-8 contract */
  externalRef?: { contract: string; namespace: string; keyType: string; publicKey: string } | null;
};

/** A CIS-8004 token id: one length byte (8), then a u64 little-endian */
export function encodeAgentTokenId(id: bigint): Buffer {
  const b = Buffer.alloc(9);
  b[0] = 8;
  b.writeBigUInt64LE(id, 1);
  return b;
}

export function decodeAgentOf(buf: Buffer): AgentOnChain | null {
  let o = 0;
  const u8 = () => buf.readUInt8(o++);
  const bytes = (n: number) => {
    if (o + n > buf.length) throw new Error("agentOf: truncated");
    const v = buf.subarray(o, o + n);
    o += n;
    return v;
  };
  const account = () => AccountAddress.toBase58(AccountAddress.fromBuffer(new Uint8Array(bytes(32)).buffer as ArrayBuffer));
  // Strict parsing: Option tags may only be 0 or 1, the token id must be exactly 8 bytes; anything else throws (so the buyer refuses to pay)
  const opt = (what: string) => {
    const t = u8();
    if (t > 1) throw new Error(`agentOf: illegal option tag ${t} for ${what}`);
    return t === 1;
  };
  if (!opt("record")) return null;
  const idLen = u8();
  if (idLen !== 8) throw new Error(`agentOf: token id length ${idLen}, expected 8`);
  const tokenId = bytes(8).readBigUInt64LE(0).toString();
  const owner = account();
  const agentUri = opt("agent_uri") ? (() => { if (o + 4 > buf.length) throw new Error("agentOf: truncated"); const n = buf.readUInt32LE(o); o += 4; return bytes(n).toString("utf8"); })() : null;
  const metadataHash = opt("metadata_hash") ? bytes(32).toString("hex") : null;
  const str = () => { if (o + 4 > buf.length) throw new Error("agentOf: truncated"); const n = buf.readUInt32LE(o); o += 4; if (n > 4096) throw new Error("agentOf: field too long"); return bytes(n); };
  // ExternalReference ::= contract_address (u64 index, u64 subindex) · kind (u8 tag; 0 = Cis8 + ExternalKeyId)
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
export async function readAgent(tokenId: string, grpc?: ReturnType<typeof createGrpc>, registry = AGENT_REGISTRY): Promise<AgentOnChain | null> {
  if (!/^\d+$/.test(tokenId)) throw new Error(`bad token id ${tokenId}`);
  // Tests only: integration tests have no real Concordium node, so a fake on-chain record comes from an environment variable (the buyer's own environment, not something a seller controls)
  if (process.env.VERIFLOW_TEST_AGENT_RECORD) return JSON.parse(process.env.VERIFLOW_TEST_AGENT_RECORD) as AgentOnChain;
  grpc ??= createGrpc();
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

if (import.meta.url === `file://${process.argv[1]}`) {
  readAgent(process.argv[2] ?? "1313").then(
    (a) => { console.log(JSON.stringify(a, null, 2)); process.exit(0); },
    (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); },
  );
}
