/**
 * 跨鏈付款（Base 上的 USDC）：把 EVM 付款人對回 Concordium 帳號
 * ---------------------------------------------------------------
 * x402 的 EVM exact 付款是一張 EIP-3009 授權（TransferWithAuthorization），由付款人的 EVM 金鑰簽 EIP-712。
 * 從簽名可以還原出簽名者的公鑰；這把公鑰若在 CIS-8 登記在某個 Concordium 帳號底下（登記時它自己簽過，
 * 合約在鏈上驗過），這筆付款就「屬於」那個 Concordium 帳號。賣方據此套用同一套資格與買方 agent 檢查。
 * 不需要買方另外送任何標頭：證據就是付款簽名本身。
 *
 * 只接受 EIP-3009（USDC 用的方式）與一般 EOA 簽名。智慧合約錢包（ERC-1271 / ERC-6492）的地址不是某把金鑰的地址，綁不進 CIS-8，拒絕。
 * Permit2 對 EOA 其實也能還原公鑰，但它是另一種 EIP-712 結構，這裡沒有實作，所以一律拒絕（涵蓋範圍的限制，不是做不到）。
 * 另外自己檢查授權的收款人與金額就是這次的 payTo 與價格（facilitator 也會檢查，這裡是第二道）。
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

/** 從 EIP-3009 付款授權還原付款人的公鑰（未壓縮，0x04…），並確認它就是 authorization.from */
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

/** EVM 付款 → 簽名者公鑰 → CIS-8（從 Concordium 節點讀）→ Concordium 帳號 */
export async function concordiumAccountOfEvmPayment(
  payload: unknown,
  req: Req,
  read?: (k: ExternalKey) => Promise<Cis8Registration | null>,
): Promise<EvmAccount> {
  const who = await evmPayerOf(payload, req);
  if (!who.ok) return who;
  // 還原出的地址必須是授權上寫的付款人（不然簽名就不是他的）；checkEvmBinding 會比對
  const b = await checkEvmBinding({ address: who.from, publicKey: who.publicKey, namespace: req.network, read });
  if (!b.ok) return { ok: false, code: "evm_payer_not_bound", reason: `${b.reason}. Bind the paying key to your Concordium account in the CIS-8 registry first` };
  return { ok: true, from: who.from, account: b.owner };
}
