/**
 * Scoring rule v1 (docs/SCORING.md): pure-function tests, no network
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { revealProblems, RULE, score, type Candle, type Commit, type Discovery } from "../src/score.ts";

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const prev = (d: string) => new Date(ms(d) - DAY).toISOString().slice(0, 10);
const ok: Discovery = { complete: true, issued: 0, listed: 0, problems: [] };

/** Simulates a new contract: the whole window starts 11/21, to test the performance computation itself */
const FRESH = { ...RULE, integrityStart: "2026-11-21", performanceStart: "2026-11-21" };

let n = 0;
/** One commitment: block time = 00:12 UTC that day, as_of = the day before; revealed=false means not revealed yet */
function commit(day: string, asset: string, signal: "RISK_ON" | "RISK_OFF", opts: { revealed?: boolean; momentum?: number; z?: number; as_of?: string; minute?: number } = {}): Commit {
  const momentum = opts.momentum ?? (signal === "RISK_ON" ? 0.05 : -0.05);
  const canonical = JSON.stringify({ as_of: opts.as_of ?? prev(day), asset, close: 1, issued_at: "x", liquidity_z: opts.z ?? 0.2, momentum, nonce: String(n++), signal });
  return {
    commitment: (n++).toString(16).padStart(64, "0"),
    asset,
    committed_at: new Date(ms(day) + (opts.minute ?? 12) * 60_000).toISOString(),
    reveal: opts.revealed === false ? null : { signal, canonical },
  };
}

/** One daily candle per day, close given by f(day number) */
function candles(from: string, count: number, f: (i: number) => number, skip: number[] = []): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < count; i++) if (!skip.includes(i)) out.push({ openTime: ms(from) + i * DAY, closeTime: ms(from) + (i + 1) * DAY - 1, close: f(i) });
  return out;
}

test("rule constants match the document", () => {
  assert.equal(RULE.integrityStart, "2026-11-20");
  assert.equal(RULE.performanceStart, RULE.integrityStart); // 11/20 already failed → this contract never publishes performance
  assert.equal(RULE.horizonDays, 7);
});

test("today's chain: the 20 Nov duplicates are failures, 21 Nov is clean, nothing is published yet", () => {
  const commits = [
    commit("2026-11-20", "BTC", "RISK_OFF", { revealed: false, minute: 180 }),
    commit("2026-11-20", "BTC", "RISK_OFF", { revealed: false, minute: 300 }),
    commit("2026-11-20", "ETH", "RISK_OFF", { revealed: false, minute: 399 }),
    commit("2026-11-20", "BTC", "RISK_OFF", { revealed: false, minute: 435 }),
    commit("2026-11-20", "ETH", "RISK_OFF", { revealed: false, minute: 523 }),
    commit("2026-11-21", "BTC", "RISK_OFF", { revealed: false }),
    commit("2026-11-21", "ETH", "RISK_OFF", { revealed: false }),
  ];
  const rep = score(commits, {}, ok, Date.parse("2026-11-22T12:00:00Z"));
  assert.deepEqual(rep.integrity.window, ["2026-11-20", "2026-11-21"]);
  assert.match((rep.performance as any).reason, /2026-11-20 BTC \(3 commits\)/); // this contract never publishes performance
  assert.deepEqual(rep.integrity.commit, { numerator: 2, denominator: 4 });
  assert.deepEqual(rep.integrity.failures.map((f) => `${f.day} ${f.asset} ${f.reason}`), ["2026-11-20 BTC 3 commits", "2026-11-20 ETH 2 commits"]);
  assert.equal(rep.integrity.reveal.denominator, 0);
  assert.equal(rep.performance.published, false);
});

test("hedge: two commits for one slot inside the performance window block publication", () => {
  const commits = [commit("2026-11-21", "BTC", "RISK_ON"), commit("2026-11-21", "BTC", "RISK_OFF", { minute: 30 }), commit("2026-11-21", "ETH", "RISK_ON")];
  const rep = score(commits, {}, ok, Date.parse("2026-12-05T00:00:00Z"), FRESH);
  assert.equal(rep.performance.published, false);
  assert.match((rep.performance as { reason: string }).reason, /2026-11-21 BTC \(2 commits\)/);
});

test("hedge under a foreign label counts as a failure even when revealed", () => {
  const commits = [commit("2026-11-21", "BTC", "RISK_ON"), commit("2026-11-21", "ETH", "RISK_ON"), commit("2026-11-21", "HEDGE", "RISK_OFF")];
  const rep = score(commits, {}, ok, Date.parse("2026-11-22T12:00:00Z"));
  assert.deepEqual(rep.integrity.commit, { numerator: 2, denominator: 5 }); // 2 days × 2 assets + 1 foreign label; both 11/20 slots are empty
  assert.ok(rep.integrity.failures.some((f) => f.asset === "HEDGE" && /not BTC or ETH/.test(f.reason)));
  assert.equal(rep.performance.published, false);
});

test("withholding: a due commit that is never revealed is a reveal failure", () => {
  const commits = [commit("2026-11-21", "BTC", "RISK_ON", { revealed: false }), commit("2026-11-21", "ETH", "RISK_ON")];
  const notYet = score(commits, {}, ok, Date.parse("2026-11-28T12:00:00Z"));
  assert.deepEqual(notYet.integrity.reveal, { numerator: 0, denominator: 0, pending: 2 });
  const due = score(commits, {}, ok, Date.parse("2026-11-29T00:13:00Z"));
  assert.deepEqual(due.integrity.reveal, { numerator: 1, denominator: 2, pending: 0 });
  assert.ok(due.integrity.failures.some((f) => f.reason === "due but not revealed"));
});

test("reveal checks: late anchor, wrong asset, signal against the rule, boundary tolerance", () => {
  assert.deepEqual(revealProblems(commit("2026-11-21", "BTC", "RISK_ON")), []);
  assert.match(revealProblems(commit("2026-11-23", "BTC", "RISK_ON", { as_of: "2026-11-20" })).join(), /not the day before/);
  const wrongAsset = commit("2026-11-21", "BTC", "RISK_ON");
  wrongAsset.asset = "ETH";
  assert.match(revealProblems(wrongAsset).join(), /revealed asset BTC/);
  assert.match(revealProblems(commit("2026-11-21", "BTC", "RISK_ON", { momentum: -0.01 })).join(), /≠ rule \(RISK_OFF\)/);
  assert.match(revealProblems(commit("2026-11-21", "BTC", "RISK_ON", { z: -1.5 })).join(), /≠ rule/);
  assert.deepEqual(revealProblems(commit("2026-11-21", "BTC", "RISK_ON", { momentum: 0.0000005 })), []); // at the threshold both labels are accepted
  assert.deepEqual(revealProblems(commit("2026-11-21", "BTC", "RISK_OFF", { momentum: 0.03, z: -1.0000004 })), []);
});

test("performance: entry at the block-day close, exit 7 candles later, both constants printed", () => {
  // BTC +1% a day, ETH −1% a day; 11/21 BTC ON, ETH OFF; 11/22 both ON
  const commits = [
    commit("2026-11-21", "BTC", "RISK_ON"), commit("2026-11-21", "ETH", "RISK_OFF", { momentum: -0.01 }),
    commit("2026-11-22", "BTC", "RISK_ON"), commit("2026-11-22", "ETH", "RISK_ON"),
  ];
  const prices = { BTC: candles("2026-11-20", 20, (i) => 100 * 1.01 ** i), ETH: candles("2026-11-20", 20, (i) => 100 * 0.99 ** i) };
  const rep = score(commits, prices, ok, Date.parse("2026-12-01T00:30:00Z"), FRESH);
  const p = rep.performance as any;
  assert.equal(p.published, false, "11/20 has no commits, but it is outside the performance window — blocked only by 11/23+ missing slots");
  assert.match(p.reason, /2026-11-23 BTC \(no commit\)/);

  // Computed before 11/23 (complete days only up to 11/22): neither day has reached its exit
  const early = score(commits, prices, ok, Date.parse("2026-11-23T01:00:00Z"), FRESH);
  assert.equal(early.performance.published, false);
  assert.deepEqual((early.performance as any).pending_days, ["2026-11-21", "2026-11-22"]);
});

test("performance numbers on a clean window", () => {
  const days = ["2026-11-21", "2026-11-22", "2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29", "2026-11-30"];
  const commits = days.flatMap((d, i) => [commit(d, "BTC", "RISK_ON"), commit(d, "ETH", i === 0 ? "RISK_OFF" : "RISK_ON", i === 0 ? { momentum: -0.01 } : {})]);
  const prices = { BTC: candles("2026-11-20", 20, (i) => 100 * 1.01 ** i), ETH: candles("2026-11-20", 20, (i) => 100 * 0.99 ** i) };
  // Run at 11/30 00:30: complete days up to 11/29; the exit must close before B+8 00:00 → 11/21 and 11/22 can be scored
  const rep = score(commits.filter((c) => c.committed_at < "2026-11-30"), prices, ok, Date.parse("2026-11-30T00:30:00Z"), FRESH);
  const p = rep.performance as any;
  assert.equal(p.published, true);
  assert.equal(p.scored_days, 2); // 11/21: exit candle 11/28 (closes 11/29 00:00); 11/22: exit 11/29 (closes 11/30 00:00) → both closed
  const btc = 1.01 ** 7 - 1;
  const eth = 0.99 ** 7 - 1;
  assert.equal(p.mean_7d_return_signal, Math.round((((btc + 0) / 2 + (btc + eth) / 2) / 2) * 1e6) / 1e6);
  assert.equal(p.mean_7d_return_always_on, Math.round(((btc + eth) / 2) * 1e6) / 1e6);
  assert.equal(p.mean_7d_return_always_off, 0);
  assert.equal(p.x_vs_always_off, p.mean_7d_return_signal);
  assert.match(p.unit, /7-day/);
  assert.equal(p.risk_off_calls, 1);
  assert.deepEqual(p.pending_days, ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29"]);
  assert.deepEqual(p.label_switches, { BTC: 0, ETH: 1 });
  assert.match(p.caveat, /constant/);
});

test("a missing Binance candle is a gap, never filled", () => {
  const commits = [commit("2026-11-21", "BTC", "RISK_ON"), commit("2026-11-21", "ETH", "RISK_ON")];
  const prices = { BTC: candles("2026-11-20", 20, () => 100, [8]), ETH: candles("2026-11-20", 20, () => 100) }; // BTC 11/28 missing
  const rep = score(commits, prices, ok, Date.parse("2026-11-22T01:00:00Z") + 7 * DAY, FRESH);
  const p = rep.performance as any;
  assert.equal(p.published, false); // a gap blocks publication instead of being silently skipped
  assert.deepEqual(p.gap_days, ["2026-11-21"]);
  assert.match(p.reason, /gap/);
});

test("a day whose exit has closed is in the mean or blocks it, never silently pending", () => {
  const days = ["2026-11-21", "2026-11-22"];
  const commits = days.flatMap((d) => [commit(d, "BTC", "RISK_ON"), commit(d, "ETH", "RISK_ON")]);
  commits[2].reveal = null; // 11/22 BTC's exit has closed, but the seller has not revealed it
  const prices = { BTC: candles("2026-11-20", 20, () => 100), ETH: candles("2026-11-20", 20, () => 100) };
  const rep = score(commits, prices, ok, Date.parse("2026-11-30T00:30:00Z"), FRESH);
  const p = rep.performance as any;
  assert.equal(p.published, false);
  assert.match(p.reason, /2026-11-22 BTC \(exit candle closed but the call is not revealed\)/);
});

test("incomplete discovery publishes nothing", () => {
  const commits = [commit("2026-11-21", "BTC", "RISK_ON"), commit("2026-11-21", "ETH", "RISK_ON")];
  const prices = { BTC: candles("2026-11-20", 20, () => 100), ETH: candles("2026-11-20", 20, () => 100) };
  const rep = score(commits, prices, { complete: false, issued: 3, listed: 2, problems: ["count"] }, Date.parse("2026-11-22T01:00:00Z") + 7 * DAY, FRESH);
  assert.equal(rep.performance.published, false);
  assert.match((rep.performance as any).reason, /INCOMPLETE/);
});
