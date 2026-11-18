/**
 * 示範買方 Agent：自動付款買一個訊號
 * ---------------------------------
 * 1. 呼叫 /signal/BTC → 拿到 402 和付款條件
 * 2. 用買方帳號簽一筆轉帳（手續費由 facilitator 代付）
 * 3. 帶著簽好的付款重送 → 拿到訊號 + 鏈上交易
 *
 * 執行：npm run buyer -- BTC
 */
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactConcordiumScheme } from "@x402/concordium/exact/client";
import { getExplorerTxUrl } from "@x402/concordium";
import { NETWORK, env, loadAccount } from "./config.js";

const asset = (process.argv[2] ?? "BTC").toUpperCase();
const buyer = loadAccount(env("BUYER_KEY_FILE"));
const gateway = env("GATEWAY_URL", "http://localhost:4020");

// Agent 花費護欄：只允許付 Concordium testnet 的 CCD，且單次最多 MAX_PAY_MICROCCD（預設 2 CCD）
// 賣方如果要求更多錢或別種資產，買方 Agent 會拒絕付款。
const MAX_PAY_MICROCCD = env("MAX_PAY_MICROCCD", "2000000");
const client = x402Client.fromConfig({
  schemes: [
    {
      network: NETWORK,
      client: new ExactConcordiumScheme({ accountAddress: buyer.accountAddress, signer: buyer.signer }),
    },
  ],
  spendControls: {
    allowedAssets: [{ network: NETWORK, asset: "CCD", maxAmountPerPayment: MAX_PAY_MICROCCD }],
  },
});
const fetchWithPay = wrapFetchWithPayment(fetch, client);

console.log(`buyer ${buyer.address} → ${gateway}/signal/${asset}`);
const res = await fetchWithPay(`${gateway}/signal/${asset}`);
console.log("status:", res.status);
console.log(JSON.stringify(await res.json(), null, 2));

const header = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
if (header) {
  const settlement = decodePaymentResponseHeader(header);
  console.log("payment:", JSON.stringify(settlement));
  if (settlement.transaction) console.log("explorer:", getExplorerTxUrl(NETWORK, settlement.transaction));
}
