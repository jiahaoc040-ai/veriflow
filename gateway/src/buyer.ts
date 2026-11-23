/**
 * 示範買方 Agent：自動付款買一個訊號
 * ---------------------------------
 * 1. 呼叫 /signal/BTC → 拿到 402 和付款條件
 * 2. 用買方帳號簽一筆轉帳（手續費由 facilitator 代付）
 * 3. 帶著簽好的付款重送 → 拿到訊號 + 鏈上交易
 *
 * 執行：npm run buyer -- BTC
 */
import { NET } from "./network.js";
import { createBuyerAgent } from "./agent.js";

const asset = (process.argv[2] ?? "BTC").toUpperCase();
const agent = createBuyerAgent();

console.log(`buyer ${agent.address} → ${agent.gateway}/signal/${asset}`);
const r = await agent.buySignal(asset);
if (r.sellerCheck) {
  console.log(`\nseller check: ${r.sellerCheck.ok ? "passed" : "FAILED — nothing was signed or paid"}`);
  for (const c of r.sellerCheck.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
}
if (r.refused) process.exit(1);
console.log("\nstatus:", r.status);
const body = r.body as { canonical?: string; commitment?: string; anchor_tx?: string } | string | undefined;
if (r.status === 200 && body && typeof body === "object") {
  console.log("canonical (hash exactly this string):", body.canonical);
  console.log("commitment:", body.commitment);
  console.log("commit tx: ", body.anchor_tx ? `${NET.explorer}/transaction/${body.anchor_tx}` : "(none)");
} else console.log(typeof body === "string" ? body : JSON.stringify(body, null, 2));
if (r.paymentExplorer) console.log("payment tx:", r.paymentExplorer);
if (r.needsVerification) console.log(`\nThis account has not proven eligibility yet. Open with the Concordium wallet: ${r.verifyUrl}`);
