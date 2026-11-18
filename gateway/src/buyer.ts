/**
 * 示範買方 Agent：自動付款買一個訊號
 * ---------------------------------
 * 1. 呼叫 /signal/BTC → 拿到 402 和付款條件
 * 2. 用買方帳號簽一筆轉帳（手續費由 facilitator 代付）
 * 3. 帶著簽好的付款重送 → 拿到訊號 + 鏈上交易
 *
 * 執行：npm run buyer -- BTC
 */
import { createBuyerAgent } from "./agent.js";

const asset = (process.argv[2] ?? "BTC").toUpperCase();
const agent = createBuyerAgent();

console.log(`buyer ${agent.address} → ${agent.gateway}/signal/${asset}`);
const r = await agent.buySignal(asset);
console.log("status:", r.status);
console.log(typeof r.body === "string" ? r.body : JSON.stringify(r.body, null, 2));
if (r.payment) console.log("payment:", JSON.stringify(r.payment));
if (r.paymentExplorer) console.log("explorer:", r.paymentExplorer);
if (r.needsVerification) console.log(`\n這個帳號還沒通過資格驗證。用 Concordium 錢包開：${r.verifyUrl}`);
