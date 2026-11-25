/**
 * CIS-8 外部金鑰登記：證明「這個其他鏈上的地址，屬於這個 Concordium 帳號」
 * ----------------------------------------------------------------------
 * 一筆登記把一把外部公鑰（例如 Base Sepolia 上的 EVM 金鑰）綁到一個 Concordium 帳號。
 * 外部金鑰要對規範化的位元組簽名（ethereum-personal-sign），合約在鏈上驗簽才記錄，所以不能冒綁別人的金鑰。
 *
 * VeriFlow 用它做跨鏈付款：
 *  - 賣方：#1313 的擁有者把收款用的 EVM 金鑰綁上去。買方付 USDC 之前，從節點讀 CIS-8，確認 payTo 的金鑰屬於 #1313 的擁有者。
 *  - 買方：把付款用的 EVM 金鑰綁到自己的 Concordium 帳號。賣方據此把 EVM 付款人對回 Concordium 帳號，
 *    再套用同一套 Verify & Access 資格與 CIS-8004 買方 agent 檢查。
 *
 * 編碼（CIS-8 規格）：String / Bytestring = u32 LE 長度 + 內容；ExternalKeyId = namespace String · key_type String · public_key Bytestring
 * ownerOfKey 回傳：0（沒有）或 1 + Registration（owner 32 bytes · ExternalKeyId · proof_scheme String · u32 筆 metadata（key String, value String）· status u8 · last_updated u64）
 */
import "./env-file.js";
import { AccountAddress, ContractAddress, Parameter, ReceiveName, ReturnValue } from "@concordium/web-sdk";
import { publicKeyToAddress } from "viem/accounts";
import { createGrpc } from "./grpc.js";
import { NET } from "./network.js";

export const CIS8_REGISTRY = ContractAddress.create(NET.cis8Registry.index, NET.cis8Registry.subindex);
export const EVM_KEY_TYPE = "secp256k1-uncompressed";
export const EVM_PROOF_SCHEME = "ethereum-personal-sign";
export const CANONICAL_TAG = "CIS-8/v1/canonical";

export type ExternalKey = { namespace: string; keyType: string; publicKey: string /* hex, 65 bytes with 0x04 */ };
export type Cis8Registration = { owner: string; status: "Active" | "Revoked"; proofScheme: string; key: ExternalKey };

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const str = (s: string) => { const v = Buffer.from(s, "utf8"); return Buffer.concat([u32(v.length), v]); };
const bstr = (v: Buffer) => Buffer.concat([u32(v.length), v]);

export function normalizePublicKey(hex: string): Buffer {
  const b = Buffer.from(hex.replace(/^0x/i, ""), "hex");
  if (b.length !== 65 || b[0] !== 0x04) throw new Error("expected an uncompressed secp256k1 public key (65 bytes, starting 04)");
  return b;
}

export function encodeExternalKey(k: ExternalKey): Buffer {
  return Buffer.concat([str(k.namespace), str(k.keyType), bstr(normalizePublicKey(k.publicKey))]);
}

/** 外部金鑰要簽的位元組（不含 EIP-191 前綴；personal_sign 會自己加） */
export function canonicalBytes(o: { account: string; contract?: ContractAddress.Type; genesisHash: string; externalNamespace: string; key: ExternalKey; proofScheme: string }): Buffer {
  const c = o.contract ?? CIS8_REGISTRY;
  const acct = Buffer.from(AccountAddress.fromBase58(o.account).decodedAddress);
  const genesis = Buffer.from(o.genesisHash.replace(/^0x/, ""), "hex");
  if (genesis.length !== 32) throw new Error("genesis hash must be 32 bytes");
  return Buffer.concat([
    Buffer.from(CANONICAL_TAG, "ascii"),
    acct,
    u64(c.index),
    u64(c.subindex),
    genesis,
    str(o.externalNamespace),
    encodeExternalKey(o.key),
    str(o.proofScheme),
  ]);
}

export function decodeOwnerOfKey(buf: Buffer): Cis8Registration | null {
  let o = 0;
  const need = (n: number) => { if (o + n > buf.length) throw new Error("ownerOfKey: truncated"); };
  const u8 = () => { need(1); return buf.readUInt8(o++); };
  const bytes = (n: number) => { need(n); const v = buf.subarray(o, o + n); o += n; return v; };
  const len = () => { need(4); const n = buf.readUInt32LE(o); o += 4; if (n > 4096) throw new Error("ownerOfKey: field too long"); return n; };
  const s = () => bytes(len()).toString("utf8");
  const tag = u8();
  if (tag === 0) return null;
  if (tag !== 1) throw new Error(`ownerOfKey: illegal tag ${tag}`);
  const owner = AccountAddress.toBase58(AccountAddress.fromBuffer(new Uint8Array(bytes(32)).buffer as ArrayBuffer));
  const namespace = s();
  const keyType = s();
  const publicKey = bytes(len()).toString("hex");
  const proofScheme = s();
  const m = len();
  for (let i = 0; i < m; i++) { s(); s(); }
  const st = u8();
  if (st > 1) throw new Error(`ownerOfKey: unknown status ${st}`);
  bytes(8); // last_updated
  return { owner, status: st === 0 ? "Active" : "Revoked", proofScheme, key: { namespace, keyType, publicKey } };
}

let receiveName: string | undefined;
async function ownerOfKeyName(grpc: ReturnType<typeof createGrpc>): Promise<string> {
  if (receiveName) return receiveName;
  const info = await grpc.getInstanceInfo(CIS8_REGISTRY);
  const contract = String((info as { name: unknown }).name).replace(/^init_/, "");
  return (receiveName = `${contract}.ownerOfKey`);
}

/** ownerOfKey 的原始回傳值（hex），除錯用 */
export async function ownerOfKeyRaw(k: ExternalKey, grpc = createGrpc()): Promise<string> {
  const res = await grpc.invokeContract({
    contract: CIS8_REGISTRY,
    method: ReceiveName.fromString(await ownerOfKeyName(grpc)),
    parameter: Parameter.fromBuffer(new Uint8Array(encodeExternalKey(k)).buffer as ArrayBuffer),
  });
  if (res.tag !== "success" || !res.returnValue) throw new Error(`CIS-8 ownerOfKey failed (${res.tag})`);
  return ReturnValue.toHexString(res.returnValue);
}

/** 從 Concordium 節點讀 CIS-8：這把外部金鑰登記在哪個帳號底下（沒有就 null） */
export async function ownerOfKey(k: ExternalKey, grpc = createGrpc()): Promise<Cis8Registration | null> {
  const res = await grpc.invokeContract({
    contract: CIS8_REGISTRY,
    method: ReceiveName.fromString(await ownerOfKeyName(grpc)),
    parameter: Parameter.fromBuffer(new Uint8Array(encodeExternalKey(k)).buffer as ArrayBuffer),
  });
  if (res.tag !== "success" || !res.returnValue) throw new Error(`CIS-8 ownerOfKey failed (${res.tag})`);
  const r = decodeOwnerOfKey(Buffer.from(ReturnValue.toHexString(res.returnValue), "hex"));
  // 回傳的金鑰必須就是查詢的那一把
  if (r && (r.key.publicKey !== normalizePublicKey(k.publicKey).toString("hex") || r.key.namespace !== k.namespace || r.key.keyType !== k.keyType))
    throw new Error(`CIS-8 returned a registration for a different key (${r.key.namespace} ${r.key.keyType} ${r.key.publicKey.slice(0, 16)}…)`);
  return r;
}

export function evmAddressOf(publicKeyHex: string): string {
  return publicKeyToAddress(`0x${normalizePublicKey(publicKeyHex).toString("hex")}`);
}

export type BindingCheck = { ok: true; owner: string } | { ok: false; reason: string };

/**
 * EVM 地址是否透過 CIS-8 綁在某個 Concordium 帳號底下：
 * 公鑰推出的地址必須是這個地址，登記必須是 Active、用 ethereum-personal-sign，擁有者（若有指定）必須相符
 */
export async function checkEvmBinding(o: { address: string; publicKey: string; namespace: string; expectOwner?: string; read?: (k: ExternalKey) => Promise<Cis8Registration | null> }, sameAccount?: (a: string, b: string) => boolean): Promise<BindingCheck> {
  let derived: string;
  try { derived = evmAddressOf(o.publicKey); } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
  if (derived.toLowerCase() !== o.address.toLowerCase()) return { ok: false, reason: `public key belongs to ${derived}, not ${o.address}` };
  let reg: Cis8Registration | null;
  try {
    reg = await (o.read ?? ownerOfKey)({ namespace: o.namespace, keyType: EVM_KEY_TYPE, publicKey: o.publicKey });
  } catch (e) {
    return { ok: false, reason: `could not read CIS-8 from a Concordium node: ${e instanceof Error ? e.message : e}` };
  }
  if (!reg) return { ok: false, reason: `${o.address} is not registered in CIS-8 under ${o.namespace}` };
  if (reg.status !== "Active") return { ok: false, reason: `the CIS-8 binding of ${o.address} is ${reg.status}` };
  if (reg.proofScheme !== EVM_PROOF_SCHEME) return { ok: false, reason: `unexpected proof scheme ${reg.proofScheme}` };
  if (o.expectOwner && !(sameAccount ? sameAccount(reg.owner, o.expectOwner) : reg.owner === o.expectOwner))
    return { ok: false, reason: `${o.address} is bound to ${reg.owner}, not ${o.expectOwner}` };
  return { ok: true, owner: reg.owner };
}
