/**
 * When a facilitator reports a failed settlement for a payment that did arrive
 * ---------------------------------------------------------------------------
 * A facilitator can time out, or report failure, after the transaction was already sent. x402 then answers 402 and the
 * buyer is charged without getting what it paid for. (Concordium's hosted testnet facilitator reported
 * "transaction not found" for transfers that finalized.) Here the seller reads that transaction itself from a node and
 * treats the payment as settled only if it is finalized, successful, sent by this payer and pays exactly the price to payTo:
 * a CCD transfer, or a PLT TokenTransfer event of exactly this token id and amount (smallest unit).
 */
import { TransactionHash, TransactionStatusEnum, type ConcordiumGRPCClient } from "@concordium/web-sdk";
import { sameAccount } from "concordium-x402-guard";

export type PaidOnChain = { ok: true } | { ok: false; why: string };

/** From a finalized transaction summary, who transferred how much CCD to whom (fields differ by SDK version, so read leniently) */
export function transferOf(summary: any): { sender?: string; to?: string; amount?: bigint } {
  const asAddr = (a: any) => (typeof a === "string" ? a : a?.address ?? (typeof a?.toString === "function" ? String(a) : undefined));
  const asAmount = (x: any) => {
    const v = x?.microCcdAmount ?? x?.value ?? x;
    try { return v === undefined || v === null ? undefined : BigInt(typeof v === "object" ? String(v) : v); } catch { return undefined; }
  };
  const t = summary?.transfer ?? summary?.transferWithMemo ?? summary;
  return { sender: asAddr(summary?.sender), to: asAddr(t?.to ?? t?.receiver), amount: asAmount(t?.amount) };
}

/** From a finalized token update summary, the PLT transfers it made */
export function pltTransfersOf(summary: any): { tokenId?: string; from?: string; to?: string; amount?: bigint }[] {
  const addr = (h: any) => {
    const a = h?.address ?? h;
    return typeof a === "string" ? a : a && typeof a.toString === "function" ? String(a) : undefined;
  };
  const events: any[] = Array.isArray(summary?.events) ? summary.events : [];
  return events
    .filter((e) => e && e.tag === "TokenTransfer")
    .map((e) => {
      let amount: bigint | undefined;
      try { amount = e.amount?.value !== undefined ? BigInt(e.amount.value) : undefined; } catch { amount = undefined; }
      const id = e.tokenId?.value ?? (typeof e.tokenId === "string" ? e.tokenId : undefined);
      return { tokenId: id, from: addr(e.from), to: addr(e.to), amount };
    });
}

/** Does a finalized, successful account transaction pay exactly this price from payer to payTo (CCD, or a PLT by token id) */
export function matchesPayment(s: any, payer: string, payTo: string, amount: string, asset: string): PaidOnChain {
  const same = (a?: string, b?: string) => { try { return !!a && !!b && sameAccount(a, b); } catch { return false; } };
  if (s?.type !== "accountTransaction" || s?.transactionType === "failed") return { ok: false, why: "transaction failed on-chain" };
  if (asset && asset !== "CCD") {
    if (s?.transactionType !== "tokenUpdate") return { ok: false, why: `not a token update (${s?.transactionType})` };
    if (!same(transferOf(s).sender, payer)) return { ok: false, why: `token update not sent by the payer ${payer}` };
    const want = BigInt(amount);
    const all = pltTransfersOf(s).filter((t) => t.tokenId === asset);
    // Net amount of this token from payer to payTo in this transaction (transfers back are subtracted)
    let net = 0n;
    for (const t of all) {
      if (t.amount === undefined) continue;
      if (same(t.from, payer) && same(t.to, payTo)) net += t.amount;
      else if (same(t.from, payTo) && same(t.to, payer)) net -= t.amount;
    }
    return net === want ? { ok: true } : { ok: false, why: `net ${asset} from ${payer} to ${payTo} is ${net}, not ${amount}` };
  }
  // A plain CCD transfer only (with or without memo): not a contract call or any other transaction that happens to move CCD
  if (s?.transactionType !== "transfer" && s?.transactionType !== "transferWithMemo") return { ok: false, why: `not a CCD transfer (${s?.transactionType})` };
  const t = transferOf(s);
  if (!same(t.sender, payer)) return { ok: false, why: `sender ${t.sender} is not the payer ${payer}` };
  if (!same(t.to, payTo)) return { ok: false, why: `receiver ${t.to} is not payTo ${payTo}` };
  if (t.amount === undefined || t.amount !== BigInt(amount)) return { ok: false, why: `amount ${t.amount} is not ${amount}` };
  return { ok: true };
}

/** Read the transaction from a node (waiting up to `waitMs` for finalization) and match it against the payment */
export async function paidOnChain(grpc: ConcordiumGRPCClient, txHash: string, payer: string, payTo: string, amount: string, asset: string, waitMs = 60_000): Promise<PaidOnChain> {
  if (!/^[0-9a-f]{64}$/i.test(txHash)) return { ok: false, why: "no transaction hash" };
  let status;
  try {
    const h = TransactionHash.fromHexString(txHash);
    await grpc.waitForTransactionFinalization(h, waitMs);
    status = await grpc.getBlockItemStatus(h);
  } catch (e) {
    return { ok: false, why: `could not read ${txHash}: ${e instanceof Error ? e.message : e}` };
  }
  if (status.status !== TransactionStatusEnum.Finalized) return { ok: false, why: "not finalized" };
  return matchesPayment(status.outcome?.summary, payer, payTo, amount, asset);
}
