/**
 * 結算回報失敗、但錢其實已經上鏈時的補救
 * --------------------------------------
 * facilitator 可能在交易已送出後才逾時或回報失敗（例如等待 finalization 太久）。
 * 這時 x402 會回 402、丟掉回應內容：買方被扣款卻拿不到訊號。
 * 這裡自己從節點讀那筆交易：已 finalized、成功、由這個付款人送出、把正確金額的 CCD 轉給 payTo，
 * 全部成立才把這次結算視為成功，讓買方拿到他付錢買的內容。CCD 從 Concordium 節點讀；PLT 一律不補救（只記錄）。
 * Base 的 USDC（paidOnEvm）：從 EVM RPC 讀交易收據，要求成功，而且收據裡有一筆由這個代幣合約發出的 Transfer：
 * 付款人 → payTo、金額剛好是價格。
 */
import { TransactionHash, TransactionStatusEnum } from "@concordium/web-sdk";
import { createPublicClient, getAddress, http, parseEventLogs, erc20Abi, type TransactionReceipt } from "viem";
import { NET } from "./network.js";
import { createGrpc } from "./grpc.js";
import { sameAccount } from "./contract-v2.js";

export type PaidOnChain = { ok: true } | { ok: false; why: string };

/** 從已 finalized 的交易摘要找出「誰轉了多少 CCD 給誰」；不同版本的摘要欄位不同，盡量寬鬆地讀 */
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

export async function paidOnChain(txHash: string, payer: string, payTo: string, amount: string, asset: string): Promise<PaidOnChain> {
  if (!/^[0-9a-f]{64}$/i.test(txHash)) return { ok: false, why: "no transaction hash" };
  if (asset && asset !== "CCD") return { ok: false, why: `recovery only handles CCD, not ${asset}` };
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
  const t = transferOf(s);
  const same = (a?: string, b?: string) => { try { return !!a && !!b && sameAccount(a, b); } catch { return false; } };
  if (!same(t.sender, payer)) return { ok: false, why: `sender ${t.sender} is not the payer ${payer}` };
  if (!same(t.to, payTo)) return { ok: false, why: `receiver ${t.to} is not payTo ${payTo}` };
  if (t.amount === undefined || t.amount !== BigInt(amount)) return { ok: false, why: `amount ${t.amount} is not ${amount}` };
  return { ok: true };
}

/** 從 EVM 收據找出「這個代幣合約，付款人 → payTo，剛好這個金額」的 Transfer */
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
