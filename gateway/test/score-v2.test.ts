/**
 * 計分規則 v2（docs/SCORING-v2.md）：純函式測試，不需要網路
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { requiredDays, RULE_V2, scoreV2, type Slots } from "../src/score-v2.ts";
import { canonicalV2, roundHalfAway, type Candle } from "../src/signal-v2.ts";
import type { SummaryV2 } from "../src/contract-v2.ts";

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const add = (d: string, n: number) => new Date(ms(d) + n * DAY).toISOString().slice(0, 10);
const NONCE = "0123456789abcdef0123456789abcdef";
const R = { ...RULE_V2, contractIndex: 1n };
const INIT = "2026-11-23T03:00:00.000Z"; // as_of 2026-11-22's window [11-23, 11-24) closes after init → required

function series(from: string, n: number, f: (i: number) => number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({ openTime: ms(from) + i * DAY, closeTime: ms(from) + (i + 1) * DAY - 1, close: f(i) }));
}
const prices = { BTC: series("2026-10-01", 80, (i) => 100 * 1.01 ** i), ETH: series("2026-10-01", 80, (i) => 100 * 0.99 ** i) };
const close = (a: "BTC" | "ETH", d: string) => prices[a].find((k) => k.openTime === ms(d))!.close;
const mom = (a: "BTC" | "ETH", d: string) => roundHalfAway((close(a, d) / close(a, add(d, -30)) - 1) * 1e6);

function slotsFor(days: string[], revealUntil = "9999-12-31", override: (a: string, d: string, c: string) => string = (_a, _d, c) => c): Slots {
  const s: Slots = new Map();
  for (const d of days)
    for (const a of ["BTC", "ETH"] as const) {
      const c = override(a, d, canonicalV2(a, d, mom(a, d), NONCE));
      const committed = new Date(ms(add(d, 1)) + 10 * 60_000).toISOString();
      s.set(`${a}|${d}`, {
        commitment: "x",
        committed_at: committed,
        reveal: d <= revealUntil ? { signal: JSON.parse(c).signal, revealed_at: committed, canonical: c } : null,
      });
    }
  return s;
}
const summary = (n: number): SummaryV2 => ({ owner: "o", committer: "c", horizon_ms: 7 * DAY, init_time: INIT, issued: n, revealed: 0 });

test("required days start with the first window that closes after init", () => {
  assert.deepEqual(requiredDays(INIT, ms("2026-11-25")), ["2026-11-22", "2026-11-23"]);
  assert.deepEqual(requiredDays(INIT, ms("2026-11-24") - 1), []);
});

test("a clean window publishes; momentum is recomputed from Binance; both constants printed", () => {
  const now = ms("2026-12-02") + 60_000; // exit of 11-23 is the 12-01 candle, closed at 12-02 00:00
  const days = requiredDays(INIT, now); // 11-22 .. 11-30
  assert.equal(days.length, 9);
  const rep = scoreV2(summary(18), slotsFor(days), prices, now, R);
  const p = rep.performance as any;
  assert.equal(rep.complete, true);
  assert.equal(p.published, true, p.reason);
  assert.equal(p.scored_days, 2);
  const btc = close("BTC", add("2026-11-22", 8)) / close("BTC", add("2026-11-22", 1)) - 1;
  const eth = close("ETH", add("2026-11-22", 8)) / close("ETH", add("2026-11-22", 1)) - 1;
  assert.equal(p.mean_7d_return_always_on, Math.round(((btc + eth) / 2) * 1e6) / 1e6);
  assert.equal(p.mean_7d_return_always_off, 0);
  assert.match(p.unit, /7-day/);
  assert.equal(p.pending_days.length, 7);
});

test("a missing slot, an unrevealed closed exit or a momentum mismatch blocks publication", () => {
  const now = ms("2026-12-02") + 60_000;
  const days = requiredDays(INIT, now);
  const missing = slotsFor(days);
  missing.delete("ETH|2026-11-23");
  assert.match((scoreV2(summary(17), missing, prices, now, R).performance as any).reason, /2026-11-23 ETH \(no commit\)/);

  const withheld = slotsFor(days, "2026-11-22");
  assert.match((scoreV2(summary(18), withheld, prices, now, R).performance as any).reason, /not revealed/);

  const forged = slotsFor(days, "9999", (a, d, c) => (a === "BTC" && d === "2026-11-22" ? c.replace(/"momentum_e6":\d+/, '"momentum_e6":1') : c));
  assert.match((scoreV2(summary(18), forged, prices, now, R).performance as any).reason, /recomputed from Binance/);
});

test("pending only while the exit candle is open; counter mismatch is INCOMPLETE", () => {
  const early = ms("2026-11-30") + 60_000;
  const rep = scoreV2(summary(2 * requiredDays(INIT, early).length), slotsFor(requiredDays(INIT, early), ""), prices, early, R); // no exit closed yet
  assert.deepEqual((rep.performance as any).pending_days, requiredDays(INIT, early));
  const days = requiredDays(INIT, ms("2026-12-02") + 60_000);
  assert.equal(rep.performance.published, false);
  const bad = scoreV2(summary(19), slotsFor(days), prices, ms("2026-12-02") + 60_000, R);
  assert.equal(bad.complete, false);
  assert.match((bad.performance as any).reason, /INCOMPLETE/);
  const id = scoreV2(summary(18), slotsFor(days), prices, ms("2026-12-02") + 60_000, R, ["init tx did not create"]);
  assert.match((id.performance as any).reason, /INCOMPLETE: init tx/);
});

test("a missing Binance candle blocks; it is never filled", () => {
  const days = requiredDays(INIT, ms("2026-12-02") + 60_000);
  const holes = { ...prices, ETH: prices.ETH.filter((k) => k.openTime !== ms("2026-11-30")) }; // exit of 11-22
  const rep = scoreV2(summary(18), slotsFor(days), holes, ms("2026-12-02") + 60_000, R);
  assert.match((rep.performance as any).reason, /candle missing/);
});
