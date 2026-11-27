/**
 * Recovery when settlement is reported as failed but the money is actually on-chain
 * --------------------------------------
 * A facilitator may time out or report failure after the transaction was already sent (e.g. waiting too long for finalization).
 * x402 then answers 402 and drops the response body: the buyer is charged but gets no signal.
 * Here we read that transaction ourselves: finalized, successful, sent by this payer, transferring exactly the price in CCD to payTo;
 * only if all hold is the settlement treated as successful and the buyer gets what they paid for. CCD and PLT payments are read from a Concordium node:
 * for a PLT, the token update must carry a TokenTransfer event of exactly this token id and amount (smallest unit), payer → payTo.
 * USDC on Base (paidOnEvm): read the transaction receipt from an EVM RPC; it must succeed and contain a Transfer emitted by this token contract,
 * payer → payTo, for exactly the price.
 */
import { TransactionHash, TransactionStatusEnum } from "@concordium/web-sdk";
import { createPublicClient, getAddress, http, parseEventLogs, erc20Abi, type TransactionReceipt } from "viem";
import { NET } from "./network.js";
import { createGrpc } from "./grpc.js";
import { sameAccount } from "./contract-v2.js";

export type PaidOnChain = { ok: true } | { ok: false; why: string };

/** From a finalized transaction summary, find who transferred how much CCD to whom; summary fields differ by version, so read leniently */
export function transferOf(summary: any): { sender?: string; to?: string; amount?: bigint } {
  const asAddr = (a: any) => (typeof a === "string" ? a : a?.address ?? (typeof a?.toString === "function" ? String(a) : undefined));
  const asAmount = (x: any) => {
    const v = x?.microCcdAmount ?? x?.value ?? x;
    try { return v === undefined || v === null ? undefined : BigInt(typeof v === "object" ? String(v) : v); } catch { return undefined; }
  };
  const t = summary?.transfer ?? summary?.transferWithMemo ?? summary;
  return {
    sender: asAddr(summary?.sender),
    to: asAddr(t?.to ?? t?.receiver),
    amount: asAmount(t?.amount),
  };
}

/** From a finalized token update summary, the PLT transfers it made (token id, sender, receiver, amount in the smallest unit) */
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

export async function paidOnChain(txHash: string, payer: string, payTo: string, amount: string, asset: string): Promise<PaidOnChain> {
  if (!/^[0-9a-f]{64}$/i.test(txHash)) return { ok: false, why: "no transaction hash" };
  const grpc = createGrpc();
  let status;
  try {
    status = await grpc.waitForTransactionFinalization(TransactionHash.fromHexString(txHash), 60_000).then(
      () => grpc.getBlockItemStatus(TransactionHash.fromHexString(txHash)),
    );
  } catch (e) {
    return { ok: false, why: `could not read ${txHash}: ${e instanceof Error ? e.message : e}` };
  }
  if (status.status !== TransactionStatusEnum.Finalized) return { ok: false, why: "not finalized" };
  const s: any = status.outcome?.summary;
  if (s?.type !== "accountTransaction" || s?.transactionType === "failed") return { ok: false, why: "transaction failed on-chain" };
  return matchesPayment(s, payer, payTo, amount, asset);
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

/** From an EVM receipt, find a Transfer from this token contract, payer → payTo, for exactly this amount */
export function evmTransferMatches(receipt: Pick<TransactionReceipt, "status" | "logs">, o: { from: string; payTo: string; amount: string; asset: string }): PaidOnChain {
  if (receipt.status !== "success") return { ok: false, why: "transaction reverted" };
  const logs = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs, strict: false });
  const want = { asset: getAddress(o.asset), from: getAddress(o.from), to: getAddress(o.payTo), amount: BigInt(o.amount) };
  const hit = logs.some((l) => {
    const a = l.args as { from?: string; to?: string; value?: bigint };
    return getAddress(l.address) === want.asset && !!a.from && !!a.to && getAddress(a.from) === want.from && getAddress(a.to) === want.to && a.value === want.amount;
  });
  return hit ? { ok: true } : { ok: false, why: `no Transfer of ${o.amount} ${o.asset} from ${o.from} to ${o.payTo} in the receipt` };
}

export async function paidOnEvm(
  txHash: string,
  o: { from: string; payTo: string; amount: string; asset: string },
  getReceipt: (h: `0x${string}`) => Promise<Pick<TransactionReceipt, "status" | "logs">> = (h) =>
    createPublicClient({ transport: http(process.env.EVM_RPC_URL || NET.evm.rpc, { timeout: 20_000 }) }).waitForTransactionReceipt({ hash: h, timeout: 60_000 }),
): Promise<PaidOnChain> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, why: "no transaction hash" };
  try {
    return evmTransferMatches(await getReceipt(txHash as `0x${string}`), o);
  } catch (e) {
    return { ok: false, why: `could not read ${txHash}: ${e instanceof Error ? e.message : e}` };
  }
}
