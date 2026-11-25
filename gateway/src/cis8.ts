/**
 * CIS-8 External Key Registry: proves that an address on another chain belongs to a Concordium account
 * ----------------------------------------------------------------------
 * A registration binds an external public key (e.g. an EVM key on Base Sepolia) to a Concordium account.
 * The external key must sign canonical bytes (ethereum-personal-sign) and the contract verifies that signature on-chain, so nobody can bind someone else's key.
 *
 * VeriFlow uses it for cross-chain payment:
 *  - Seller: #1313's owner binds the EVM payout key. Before paying USDC, the buyer reads CIS-8 from a node and confirms payTo's key belongs to #1313's owner.
 *  - Buyer: binds its paying EVM key to its own Concordium account. The seller uses that to map the EVM payer back to a Concordium account
 *    and applies the same Verify & Access eligibility and CIS-8004 buyer-agent checks.
 *
 * Encoding (CIS-8 spec): String / Bytestring = u32 LE length + content; ExternalKeyId = namespace String · key_type String · public_key Bytestring
 * ownerOfKey returns: 0 (none) or 1 + Registration (owner 32 bytes · ExternalKeyId · proof_scheme String · u32 metadata count (key String, value String) · status u8 · last_updated u64)
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

/** 65-byte uncompressed → 33-byte compressed (02 = even y, 03 = odd) */
export function compressPublicKey(hex: string): Buffer {
  const b = normalizePublicKey(hex);
  return Buffer.concat([Buffer.from([b[64] & 1 ? 0x03 : 0x02]), b.subarray(1, 33)]);
}

/** Same secp256k1 key: same namespace and the same public key once compressed */
export function sameExternalKey(got: ExternalKey, asked: ExternalKey): boolean {
  if (got.namespace !== asked.namespace) return false;
  const g = got.publicKey.replace(/^0x/i, "").toLowerCase();
  const want = asked.keyType === "secp256k1-uncompressed" ? compressPublicKey(asked.publicKey).toString("hex") : asked.publicKey.replace(/^0x/i, "").toLowerCase();
  if (got.keyType === "secp256k1-compressed") return g === want;
  if (got.keyType === "secp256k1-uncompressed") return compressPublicKey(g).toString("hex") === want;
  // Other key types (e.g. ed25519): type and bytes must be exactly equal
  return got.keyType === asked.keyType && g === asked.publicKey.replace(/^0x/i, "").toLowerCase();
}

export function encodeExternalKey(k: ExternalKey): Buffer {
  // Uncompressed secp256k1 is format-checked first; other types are encoded as given
  const pk = k.keyType === "secp256k1-uncompressed" ? normalizePublicKey(k.publicKey) : Buffer.from(k.publicKey.replace(/^0x/i, ""), "hex");
  return Buffer.concat([str(k.namespace), str(k.keyType), bstr(pk)]);
}

/** The bytes the external key signs (without the EIP-191 prefix; personal_sign adds it) */
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

/** Raw ownerOfKey return value (hex), for debugging */
export async function ownerOfKeyRaw(k: ExternalKey, grpc = createGrpc()): Promise<string> {
  const res = await grpc.invokeContract({
    contract: CIS8_REGISTRY,
    method: ReceiveName.fromString(await ownerOfKeyName(grpc)),
    parameter: Parameter.fromBuffer(new Uint8Array(encodeExternalKey(k)).buffer as ArrayBuffer),
  });
  if (res.tag !== "success" || !res.returnValue) throw new Error(`CIS-8 ownerOfKey failed (${res.tag})`);
  return ReturnValue.toHexString(res.returnValue);
}

/** Read CIS-8 from a Concordium node: which account this external key is registered under (null if none) */
export async function ownerOfKey(k: ExternalKey, grpc = createGrpc()): Promise<Cis8Registration | null> {
  const res = await grpc.invokeContract({
    contract: CIS8_REGISTRY,
    method: ReceiveName.fromString(await ownerOfKeyName(grpc)),
    parameter: Parameter.fromBuffer(new Uint8Array(encodeExternalKey(k)).buffer as ArrayBuffer),
  });
  if (res.tag !== "success" || !res.returnValue) throw new Error(`CIS-8 ownerOfKey failed (${res.tag})`);
  const r = decodeOwnerOfKey(Buffer.from(ReturnValue.toHexString(res.returnValue), "hex"));
  // The returned key must be the one queried. The contract stores every secp256k1 key compressed (33 bytes, 02/03 prefix), so accept either form
  if (r && !sameExternalKey(r.key, k))
    throw new Error(`CIS-8 returned a registration for a different key (${r.key.namespace} ${r.key.keyType} ${r.key.publicKey.slice(0, 16)}…)`);
  return r;
}

export function evmAddressOf(publicKeyHex: string): string {
  return publicKeyToAddress(`0x${normalizePublicKey(publicKeyHex).toString("hex")}`);
}

export type BindingCheck = { ok: true; owner: string } | { ok: false; reason: string };

/**
 * Is an EVM address bound to a Concordium account through CIS-8:
 * the address derived from the public key must be this address, the registration Active with ethereum-personal-sign, and the owner (if given) must match
 */
export async function checkEvmBinding(o: { address: string; publicKey: string; namespace: string; expectOwner?: string; keyType?: string; read?: (k: ExternalKey) => Promise<Cis8Registration | null> }, sameAccount?: (a: string, b: string) => boolean): Promise<BindingCheck> {
  let derived: string;
  try { derived = evmAddressOf(o.publicKey); } catch (e) { return { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
  if (derived.toLowerCase() !== o.address.toLowerCase()) return { ok: false, reason: `public key belongs to ${derived}, not ${o.address}` };
  let reg: Cis8Registration | null;
  try {
    // Public nodes sometimes answer a single call with a 502 or a reset: retry twice before giving up (still fail closed after that)
    const key = { namespace: o.namespace, keyType: o.keyType ?? EVM_KEY_TYPE, publicKey: o.publicKey };
    const read = o.read ?? ownerOfKey;
    for (let i = 0; ; i++) {
      try { reg = await read(key); break; } catch (e) {
        if (i >= 2 || !/\b5\d\d\b|ECONNRESET|UNAVAILABLE|timed? ?out|DEADLINE/i.test(e instanceof Error ? e.message : String(e))) throw e;
        await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
      }
    }
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
