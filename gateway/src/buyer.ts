/**
 * Demo buyer agent: pays for one signal automatically
 * ---------------------------------
 * 1. call /signal/BTC → get the 402 and payment terms
 * 2. sign a transfer from the buyer account (the facilitator pays the fee)
 * 3. resend with the signed payment → get the signal + on-chain transactions
 *
 * Run: npm run buyer -- BTC
 */
import { NET } from "./network.js";
import { createBuyerAgent } from "./agent.js";

const asset = (process.argv[2] ?? "BTC").toUpperCase();
const agent = createBuyerAgent();

console.log(`buyer ${agent.address}${agent.agentTokenId ? ` (agent #${agent.agentTokenId})` : ""} → ${agent.gateway}/signal/${asset}, paying in ${agent.payAsset}${agent.evmAddress ? ` on ${agent.payNetwork} from ${agent.evmAddress}` : ""}`);
const r = await agent.buySignal(asset);
if (r.sellerCheck) {
  console.log(`\nseller check: ${r.sellerCheck.ok ? "passed" : "FAILED — nothing was signed or paid"}`);
  for (const c of r.sellerCheck.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
}
if (r.refused) process.exit(1);
console.log("\nstatus:", r.status);
const body = r.body as { canonical?: string; commitment?: string; anchor_tx?: string; buyer_agent?: { token_id: string; checked: string }; evm_payer?: { address: string; concordium_account: string; checked: string }; buyer_eligibility?: { verification_request_tx: string; audit_record_tx: string; valid_until: string; checked: string } } | string | undefined;
if (r.status === 200 && body && typeof body === "object") {
  if (body.evm_payer) console.log(`the seller mapped our EVM payer ${body.evm_payer.address} to Concordium account ${body.evm_payer.concordium_account} — ${body.evm_payer.checked}`);
  if (body.buyer_eligibility) console.log(`the seller re-checked our eligibility proof — ${body.buyer_eligibility.checked}\n  proof request ${body.buyer_eligibility.verification_request_tx}\n  audit record  ${body.buyer_eligibility.audit_record_tx}\n  valid until   ${body.buyer_eligibility.valid_until}`);
  if (body.buyer_agent) console.log(`the seller checked us: agent #${body.buyer_agent.token_id} — ${body.buyer_agent.checked}`);
  console.log("canonical (hash exactly this string):", body.canonical);
  console.log("commitment:", body.commitment);
  console.log("commit tx: ", body.anchor_tx ? `${NET.explorer}/transaction/${body.anchor_tx}` : "(none)");
  console.log("check it yourself: npm run check-call   (then paste the canonical string above)");
} else console.log(typeof body === "string" ? body : JSON.stringify(body, null, 2));
if (r.paymentExplorer) console.log("payment tx:", r.paymentExplorer);
// The transaction expiry is set from this computer's clock; if it runs fast the facilitator refuses it (nothing is charged)
if (/expiry_too_far_in_future/.test(JSON.stringify(r.body ?? ""))) {
  console.log("\nhint: your computer's clock is probably ahead of real time. Sync it (Windows: Settings → Time & language → Date & time → Sync now; macOS: System Settings → General → Date & Time → set automatically) and run again. Nothing was charged.");
}
const pr = r.payment as { success?: boolean; errorReason?: string; errorMessage?: string } | undefined;
if (pr && pr.success === false) console.log(`settlement reported: ${pr.errorReason ?? "failed"}${pr.errorMessage && pr.errorMessage !== pr.errorReason ? ` — ${pr.errorMessage}` : ""}`);
if (r.buyerAgentRefused) console.log(`\nThe seller refused our agent identity (nothing was charged). Check BUYER_AGENT_TOKEN_ID and that agent's on-chain agentWallet is ${agent.address}.`);
if (r.needsVerification) console.log(`\nThis account has not proven eligibility yet. Open with the Concordium wallet: ${r.verifyUrl}`);
