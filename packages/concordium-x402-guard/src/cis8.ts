/** CIS-8 External Key Registry: is an EVM payout address bound to a Concordium account */
import { AccountAddress, Parameter, ReceiveName, ReturnValue, type ContractAddress, type ConcordiumGRPCClient } from "@concordium/web-sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

export const EVM_KEY_TYPE = "secp256k1-uncompressed";
export const EVM_PROOF_SCHEME = "ethereum-personal-sign";

export type ExternalKey = { namespace: string; keyType: string; publicKey: string };
export type Cis8Registration = { owner: string; status: "Active" | "Revoked"; proofScheme: string; key: ExternalKey };

const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const str = (s: string) => { const v = Buffer.from(s, "utf8"); return Buffer.concat([u32(v.length), v]); };
const bstr = (v: Buffer) => Buffer.concat([u32(v.length), v]);

/** secp256k1 public key (33-byte compressed or 65-byte uncompressed hex, 0x optional) → 65-byte uncompressed */
export function uncompressed(hex: string): Buffer {
  return Buffer.from(secp256k1.ProjectivePoint.fromHex(hex.replace(/^0x/i, "").toLowerCase()).toRawBytes(false));
}

export function compressed(hex: string): Buffer {
  return Buffer.from(secp256k1.ProjectivePoint.fromHex(hex.replace(/^0x/i, "").toLowerCase()).toRawBytes(true));
}

/** EVM address (lower case) of a secp256k1 public key */
export function evmAddressOf(publicKeyHex: string): string {
  const pub = uncompressed(publicKeyHex).subarray(1);
  return `0x${Buffer.from(keccak_256(pub)).subarray(12).toString("hex")}`;
}

export function encodeExternalKey(k: ExternalKey): Buffer {
  const pk = k.keyType === EVM_KEY_TYPE ? uncompressed(k.publicKey) : Buffer.from(k.publicKey.replace(/^0x/i, ""), "hex");
  return Buffer.concat([str(k.namespace), str(k.keyType), bstr(pk)]);
}

/** Same key: same namespace and type, and for secp256k1 the same point in either form */
export function sameExternalKey(got: ExternalKey, asked: ExternalKey): boolean {
  if (got.namespace !== asked.namespace) return false;
  if (/^secp256k1/.test(got.keyType) && /^secp256k1/.test(asked.keyType)) {
    try { return compressed(got.publicKey).equals(compressed(asked.publicKey)); } catch { return false; }
  }
  return got.keyType === asked.keyType && got.publicKey.replace(/^0x/i, "").toLowerCase() === asked.publicKey.replace(/^0x/i, "").toLowerCase();
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
  bytes(8);
  return { owner, status: st === 0 ? "Active" : "Revoked", proofScheme, key: { namespace, keyType, publicKey } };
}

/** Read CIS-8 from a node: which account this external key is registered under (null if none) */
export async function ownerOfKey(grpc: ConcordiumGRPCClient, contract: ContractAddress.Type, k: ExternalKey): Promise<Cis8Registration | null> {
  const info = await grpc.getInstanceInfo(contract);
  const name = `${String((info as { name: unknown }).name).replace(/^init_/, "")}.ownerOfKey`;
  const res = await grpc.invokeContract({ contract, method: ReceiveName.fromString(name), parameter: Parameter.fromBuffer(new Uint8Array(encodeExternalKey(k)).buffer as ArrayBuffer) });
  if (res.tag !== "success" || !res.returnValue) throw new Error(`CIS-8 ownerOfKey failed (${res.tag})`);
  const r = decodeOwnerOfKey(Buffer.from(ReturnValue.toHexString(res.returnValue), "hex"));
  if (r && !sameExternalKey(r.key, k)) throw new Error("CIS-8 returned a registration for a different key");
  return r;
}

export type BindingCheck = { ok: true; owner: string } | { ok: false; reason: string };

/** The address derived from the key must be `address`, the registration Active with ethereum-personal-sign, and its owner `expectOwner` */
export async function checkEvmBinding(
  o: { address: string; publicKey: string; namespace: string; expectOwner?: string; keyType?: string },
  read: (k: ExternalKey) => Promise<Cis8Registration | null>,
  same: (a: string, b: string) => boolean = (a, b) => a === b,
): Promise<BindingCheck> {
  let derived: string;
  try { derived = evmAddressOf(o.publicKey); } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
  if (derived !== o.address.toLowerCase()) return { ok: false, reason: `public key belongs to ${derived}, not ${o.address}` };
  let reg: Cis8Registration | null;
  try {
    reg = await read({ namespace: o.namespace, keyType: o.keyType ?? EVM_KEY_TYPE, publicKey: o.publicKey });
  } catch (e) {
    return { ok: false, reason: `could not read CIS-8 from a Concordium node: ${e instanceof Error ? e.message : e}` };
  }
  if (!reg) return { ok: false, reason: `${o.address} is not registered in CIS-8 under ${o.namespace}` };
  if (reg.status !== "Active") return { ok: false, reason: `the CIS-8 binding of ${o.address} is ${reg.status}` };
  if (reg.proofScheme !== EVM_PROOF_SCHEME) return { ok: false, reason: `unexpected proof scheme ${reg.proofScheme}` };
  if (o.expectOwner && !same(reg.owner, o.expectOwner)) return { ok: false, reason: `${o.address} is bound to ${reg.owner}, not ${o.expectOwner}` };
  return { ok: true, owner: reg.owner };
}
