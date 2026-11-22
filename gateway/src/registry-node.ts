/**
 * 直接向 Concordium 節點讀 Agent Registry（CIS-8004 <12802,0>），不經過託管的查詢服務
 * -------------------------------------------------------------------------------
 * CIS-8004.agentOf(token id) 回傳 Option<agent record>，欄位依序：
 *   token_id ByteList(U8) · owner_account 32 bytes · agent_uri Option<String U32> · metadata_hash Option<32 bytes>
 *   · external_reference Option<…> · agent_wallet Option<AccountAddress> · status enum(Active=0, Revoked=1)
 *   · registered_at u64 · revoked_at Option<u64> · revocation_reason Option<String> · on_chain_metadata …
 * 我們只需要讀到 status；之後的欄位不解析。
 */
import "./env-file.js";
import { AccountAddress, ContractAddress, Parameter, ReceiveName, ReturnValue } from "@concordium/web-sdk";
import { createGrpc } from "./grpc.js";

export const AGENT_REGISTRY = ContractAddress.create(12802n, 0n);

export type AgentOnChain = {
  tokenId: string;
  owner: string;
  agentUri: string | null;
  metadataHash: string | null;
  wallet: string | null;
  status: "Active" | "Revoked";
};

/** CIS-8004 的 token id：長度一個 byte（8），接著 u64 little-endian */
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
  if (u8() === 0) return null;
  const idBytes = bytes(u8());
  const tokenId = idBytes.length === 8 ? idBytes.readBigUInt64LE(0).toString() : idBytes.toString("hex");
  const owner = account();
  const agentUri = u8() === 1 ? (() => { const n = buf.readUInt32LE(o); o += 4; return bytes(n).toString("utf8"); })() : null;
  const metadataHash = u8() === 1 ? bytes(32).toString("hex") : null;
  if (u8() === 1) throw new Error("agentOf: external_reference is set; this reader does not decode it");
  const wallet = u8() === 1 ? account() : null;
  const tag = u8();
  if (tag > 1) throw new Error(`agentOf: unknown status tag ${tag}`);
  return { tokenId, owner, agentUri, metadataHash, wallet, status: tag === 0 ? "Active" : "Revoked" };
}

/** 讀一個 agent；沒有這個 agent 回傳 null，節點連不上就丟錯 */
export async function readAgent(tokenId: string, grpc = createGrpc(), registry = AGENT_REGISTRY): Promise<AgentOnChain | null> {
  if (!/^\d+$/.test(tokenId)) throw new Error(`bad token id ${tokenId}`);
  const res = await grpc.invokeContract({
    contract: registry,
    method: ReceiveName.fromString("CIS-8004.agentOf"),
    parameter: Parameter.fromBuffer(new Uint8Array(encodeAgentTokenId(BigInt(tokenId))).buffer as ArrayBuffer),
  });
  if (res.tag !== "success" || !res.returnValue) throw new Error(`CIS-8004.agentOf failed (${res.tag})`);
  return decodeAgentOf(Buffer.from(ReturnValue.toHexString(res.returnValue), "hex"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  readAgent(process.argv[2] ?? "1313").then(
    (a) => { console.log(JSON.stringify(a, null, 2)); process.exit(0); },
    (e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); },
  );
}
