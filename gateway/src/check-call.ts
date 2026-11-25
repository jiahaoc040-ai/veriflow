/**
 * Check a bought call in one command, on any OS (TRY_IT Path A, steps 1–3)
 * -------------------------------------------------------------------------
 *   npm run check-call                 then paste the canonical string when asked (works in any shell, including Windows PowerShell)
 *   npm run check-call -- '<canonical>' (bash/zsh; PowerShell 5.1 strips the inner double quotes, so paste instead)
 *
 * 1. SHA-256 of the string = the commitment
 * 2. contract v2 <13115,0>, read from a public Concordium node: the slot (asset, as_of) holds exactly that commitment,
 *    committed within the day after the as_of close
 * 3. Binance: momentum_e6 recomputed from the two daily closes, and the label follows the rule
 * No key, no .env, no payment. Every value it uses is printed so you can check it by hand.
 */
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { ContractAddress } from "@concordium/web-sdk";
import { createV2Reader, v2Address, TESTNET_REGISTRY_V2_INDEX } from "./contract-v2.js";
import { binanceDaily, momentumE6, ruleV2, dayMs, dayOf, LOOKBACK_DAYS, SYMBOLS } from "./signal-v2.js";

const DAY = 86_400_000;
let raw = process.argv.slice(2).join(" ").trim();
if (!raw) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  raw = (await rl.question("Paste the canonical string exactly as the buyer printed it, then press Enter:\n")).trim();
  rl.close();
}
let call: { as_of?: string; asset?: string; momentum_e6?: number; signal?: string };
try {
  call = JSON.parse(raw);
} catch {
  console.error("that is not the canonical JSON string; run npm run check-call with no arguments and paste it when asked");
  process.exit(2);
}
const { as_of, asset, momentum_e6, signal } = call;
if (!as_of || !asset || typeof momentum_e6 !== "number" || !signal || !SYMBOLS[asset]) {
  console.error("the string must have as_of, asset (BTC or ETH), momentum_e6 and signal");
  process.exit(2);
}

let ok = true;
const line = (pass: boolean, what: string, detail: string) => {
  ok &&= pass;
  console.log(`${pass ? "✓" : "✗"} ${what} — ${detail}`);
};

// 1. hash
const commitment = createHash("sha256").update(raw, "utf8").digest("hex");
console.log(`commitment (SHA-256 of the string): ${commitment}\n`);

// 2. chain
const contract = v2Address() ?? ContractAddress.create(TESTNET_REGISTRY_V2_INDEX, 0n);
const slot = await createV2Reader(contract).slot(asset, as_of).catch((e) => {
  console.error(`could not read the contract from a Concordium node (${e instanceof Error ? e.message : e}); run again`);
  process.exit(1);
});
line(!!slot && slot.commitment === commitment, `contract <${contract.index},${contract.subindex}> stores this commitment for ${asset} ${as_of}`, slot ? `on-chain ${slot.commitment}` : "no commit for that slot");
if (slot) {
  const t = Date.parse(slot.committed_at), close = dayMs(as_of) + DAY;
  line(t >= close && t < close + DAY, "committed within the day after the close, before any outcome", `committed ${slot.committed_at}; the ${as_of} candle closed ${new Date(close).toISOString()}`);
}

// 3. Binance
const before = dayOf(dayMs(as_of) - LOOKBACK_DAYS * DAY);
const candles = await binanceDaily(asset, before).catch((e) => {
  console.error(`could not read Binance (${e instanceof Error ? e.message : e}); if you get HTTP 451, use the hand calculation in TRY_IT step 3`);
  process.exit(1);
});
const m = momentumE6(candles, as_of);
const at = (d: string) => candles.find((c) => dayOf(c.openTime) === d);
console.log(`\nBinance ${SYMBOLS[asset]} closes: ${as_of} ${at(as_of)?.close ?? "?"} · ${before} ${at(before)?.close ?? "?"} (candles opening at ${dayMs(as_of)} and ${dayMs(before)} ms)`);
line(m === momentum_e6, "momentum_e6 equals Binance's 30-day change", `recomputed ${m}, call says ${momentum_e6}`);
line(m !== null && ruleV2(m) === signal, "the label follows the rule (RISK_ON only if momentum_e6 > 0)", `${signal}`);

console.log(ok ? "\n✅ all checks pass" : "\n❌ at least one check failed");
process.exit(ok ? 0 : 1);
