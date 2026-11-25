/**
 * Cross-chain payment (USDC on Base): map the EVM payer back to a Concordium account
 * ---------------------------------------------------------------
 * An x402 EVM exact payment is an EIP-3009 authorization (TransferWithAuthorization) that the payer's EVM key signs as EIP-712.
 * The signer's public key can be recovered from the signature; if that key is registered in CIS-8 under a Concordium account (it signed the registration itself,
 * and the contract verified it on-chain), the payment belongs to that Concordium account. The seller then applies the same eligibility and buyer-agent checks.
 * The buyer sends no extra header: the evidence is the payment signature itself.
 *
 * Only EIP-3009 (what USDC uses) and plain EOA signatures are accepted. A smart-contract wallet's address (ERC-1271 / ERC-6492) is not a key's address and cannot be a CIS-8 subject, so it is refused.
 * Permit2 is also recoverable for an EOA, but it is a different EIP-712 structure that is not implemented here, so it is refused (a coverage limit, not an impossibility).
 * We also check that the authorization's payee and amount are this payTo and price (the facilitator checks too; this is a second line).
 */
import { getAddress, hashTypedData, recoverPublicKey, type Hex } from "viem";
import { checkEvmBinding, type Cis8Registration, type ExternalKey } from "./cis8.js";

export const isEvmNetwork = (n: string) => /^eip155:\d+$/.test(n);

const authorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

type Req = { network: string; asset: string; payTo: string; amount: string; extra?: Record<string, unknown> };
export type EvmPayer = { ok: true; from: string; publicKey: string } | { ok: false; code: string; reason: string };

/** Recover the payer's public key (uncompressed, 0x04…) from an EIP-3009 authorization, and confirm it is authorization.from */
export async function evmPayerOf(payload: unknown, req: Req): Promise<EvmPayer> {
  const p = payload as { signature?: string; authorization?: Record<string, string>; permit2Authorization?: unknown } | undefined;
  if (p?.permit2Authorization) return { ok: false, code: "evm_unsupported", reason: "only EIP-3009 (USDC transferWithAuthorization) payments are accepted, not Permit2" };
  const a = p?.authorization;
  if (!a || !p?.signature || !/^0x[0-9a-fA-F]{130}$/.test(p.signature)) return { ok: false, code: "evm_unsupported", reason: "the payment is not a 65-byte EOA signature over an EIP-3009 authorization" };
  try {
    if (getAddress(a.to) !== getAddress(req.payTo)) return { ok: false, code: "evm_wrong_payee", reason: `the authorization pays ${a.to}, not ${req.payTo}` };
    if (BigInt(a.value) !== BigInt(req.amount)) return { ok: false, code: "evm_wrong_amount", reason: `the authorization is for ${a.value}, not ${req.amount}` };
  } catch {
    return { ok: false, code: "evm_unsupported", reason: "malformed authorization (to / value)" };
  }
  const name = req.extra?.name, version = req.extra?.version;
  if (typeof name !== "string" || typeof version !== "string") return { ok: false, code: "evm_unsupported", reason: "the payment requirements have no EIP-712 domain" };
  let publicKey: string;
  try {
    const hash = hashTypedData({
      domain: { name, version, chainId: Number(req.network.split(":")[1]), verifyingContract: getAddress(req.asset) },
      types: authorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: {
        from: getAddress(a.from), to: getAddress(a.to), value: BigInt(a.value),
        validAfter: BigInt(a.validAfter), validBefore: BigInt(a.validBefore), nonce: a.nonce as Hex,
      },
    });
    publicKey = await recoverPublicKey({ hash, signature: p.signature as Hex });
  } catch (e) {
    return { ok: false, code: "evm_bad_signature", reason: `could not recover the payer's key: ${e instanceof Error ? e.message : e}` };
  }
  return { ok: true, from: getAddress(a.from), publicKey };
}

export type EvmAccount = { ok: true; from: string; account: string } | { ok: false; code: string; reason: string };

/** EVM payment → signer's public key → CIS-8 (read from a Concordium node) → Concordium account */
export async function concordiumAccountOfEvmPayment(
  payload: unknown,
  req: Req,
  read?: (k: ExternalKey) => Promise<Cis8Registration | null>,
): Promise<EvmAccount> {
  const who = await evmPayerOf(payload, req);
  if (!who.ok) return who;
  // The recovered address must be the payer named in the authorization (otherwise the signature is not theirs); checkEvmBinding compares them
  const b = await checkEvmBinding({ address: who.from, publicKey: who.publicKey, namespace: req.network, read });
  if (!b.ok) return { ok: false, code: "evm_payer_not_bound", reason: `${b.reason}. Bind the paying key to your Concordium account in the CIS-8 registry first` };
  return { ok: true, from: who.from, account: b.owner };
}
