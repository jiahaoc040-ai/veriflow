/**
 * 訊號 v2 與每日 v2 排程：純函式與假的鏈／資料庫，不需要網路
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { canonicalV2, divHalfAway, momentumE6, roundHalfAway, ruleV2, toUnits, type Candle } from "../src/signal-v2.ts";
import { runDailyV2, type Row } from "../src/daily-v2.ts";
import { decodeSlotV2, decodeSummaryV2, encodeCommitV2 } from "../src/contract-v2.ts";
import type { SlotV2 } from "../src/contract-v2.ts";

const DAY = 86_400_000;
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const NONCE = "0123456789abcdef0123456789abcdef";

function series(from: string, n: number, f: (i: number) => number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({ openTime: ms(from) + i * DAY, closeTime: ms(from) + (i + 1) * DAY - 1, close: f(i), closeUnits: toUnits(f(i).toFixed(8)) }));
}

test("rounding is half away from zero, unlike Python's round", () => {
  assert.equal(roundHalfAway(2.5), 3);
  assert.equal(roundHalfAway(-2.5), -3);
  assert.equal(roundHalfAway(0.4999), 0);
  assert.equal(roundHalfAway(-0.5), -1);
});

test("momentum is close(D)/close(D-30)-1 in millionths; the rule is momentum_e6 > 0", () => {
  const c = series("2026-10-01", 60, (i) => 100 + i);
  // as_of 2026-11-10 is index 40, 30 days earlier is index 10
  assert.equal(momentumE6(c, "2026-11-10"), Number(divHalfAway((140n - 110n) * 1_000_000n, 110n)));
  assert.equal(momentumE6(c, "2026-10-15"), null); // 30 days earlier is not in the series
  assert.equal(ruleV2(1), "RISK_ON");
  assert.equal(ruleV2(0), "RISK_OFF");
});

test("momentum is exact integer arithmetic on Binance's decimal strings, not float", () => {
  // 20000.01 / 20000.00 − 1 is exactly +0.5 millionths → rounds half away to 1 (RISK_ON).
  // Float division gives 0.49999999984… and would round to 0 (RISK_OFF).
  const k = (d: string, s: string): Candle => ({ openTime: ms(d), closeTime: ms(d) + DAY - 1, close: Number(s), closeUnits: toUnits(s) });
  for (const [then, now] of [["20000.00000000", "20000.01000000"], ["40000.00", "40000.02"], ["80000", "80000.04"]]) {
    const c = [k("2026-10-24", then), k("2026-11-23", now)];
    assert.equal(momentumE6(c, "2026-11-23"), 1);
    assert.equal(roundHalfAway((Number(now) / Number(then) - 1) * 1e6), 0); // the float path this replaces
  }
  const down = [k("2026-10-24", "20000.01"), k("2026-11-23", "20000.00")];
  assert.equal(momentumE6(down, "2026-11-23"), 0); // −0.49999… millionths → 0 → RISK_OFF
  assert.throws(() => toUnits("1e5"));
  assert.throws(() => toUnits("1.123456789"));
  assert.equal(divHalfAway(-5n, 10n), -1n);
  assert.equal(divHalfAway(-4n, 10n), 0n);
});

test("canonical matches the contract's fixed schema byte for byte", () => {
  assert.equal(
    canonicalV2("BTC", "2026-11-23", -12345, NONCE),
    '{"as_of":"2026-11-23","asset":"BTC","momentum_e6":-12345,"nonce":"0123456789abcdef0123456789abcdef","signal":"RISK_OFF"}',
  );
  assert.throws(() => canonicalV2("SOL", "2026-11-23", 1, NONCE));
  assert.throws(() => canonicalV2("BTC", "2026-11-23", 1.5, NONCE));
});

test("encoders and decoders round-trip the contract's layout", () => {
  const p = encodeCommitV2("BTC", "2026-11-23", "ab".repeat(32));
  assert.equal(p.toString("hex"), "03000000" + Buffer.from("BTC").toString("hex") + "0a000000" + Buffer.from("2026-11-23").toString("hex") + "ab".repeat(32));
  const canon = "x";
  const rec = Buffer.concat([Buffer.from([1]), Buffer.from("cd".repeat(32), "hex"), u64(1000), Buffer.from([1, 1]), u64(2000), Buffer.from([1, 0, 0, 0]), Buffer.from(canon)]);
  assert.deepEqual(decodeSlotV2(rec), {
    commitment: "cd".repeat(32),
    committed_at: new Date(1000).toISOString(),
    reveal: { signal: "RISK_OFF", revealed_at: new Date(2000).toISOString(), canonical: "x" },
  });
  assert.equal(decodeSlotV2(Buffer.from([0])), null);
  const sum = Buffer.concat([Buffer.alloc(32, 1), Buffer.from([0]), u64(7 * DAY), u64(5), u64(2), u64(1)]);
  assert.equal(decodeSummaryV2(sum).committer, null);
  assert.equal(decodeSummaryV2(sum).issued, 2);
});

function u64(n: number) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}

function world(now: number) {
  const slots = new Map<string, SlotV2>();
  const rows: (Row & { signal?: string })[] = [];
  const sent: string[] = [];
  const candles = series("2026-10-01", 80, (i) => 100 + i);
  return {
    slots,
    rows,
    sent,
    deps: {
      now,
      assets: ["BTC", "ETH"],
      nonce: () => NONCE,
      slot: async (a: string, d: string) => slots.get(`${a}|${d}`) ?? null,
      commit: async (a: string, d: string, c: string, onSent?: (tx: string) => Promise<void>) => {
        sent.push(`commit ${a} ${d}`);
        await onSent?.(`tx-${a}-${d}`);
        slots.set(`${a}|${d}`, { commitment: c, committed_at: new Date(now).toISOString(), reveal: null });
        return `tx-${a}-${d}`;
      },
      reveal: async (canonical: string) => {
        sent.push(`reveal ${canonical.slice(0, 40)}`);
        return "tx-reveal";
      },
      candles: async () => candles,
      db: {
        v2Rows: async () => rows.filter((r) => r.canonical.includes("momentum_e6")),
        forDay: async (a: string, d: string) => rows.filter((r) => r.asset === a && r.as_of === d),
        // 模擬資料庫的唯一索引：同一資產同一天只能有一筆 v2 訊號
        insert: async (r: any) => void (rows.some((x) => x.asset === r.asset && x.as_of === r.as_of) || rows.push({ ...r, anchor_tx: null })),
        setAnchor: async (c: string, tx: string | null) => void (rows.find((r) => r.commitment === c)!.anchor_tx = tx),
      },
    },
  };
}

test("daily v2: commits yesterday's close once per asset, writes the row first, records the tx", async () => {
  const now = ms("2026-11-24") + 20 * 60_000;
  const w = world(now);
  const out = await runDailyV2(w.deps);
  assert.deepEqual(out.commits.map((c) => c.split(" ").slice(0, 2).join(" ")), ["BTC 2026-11-23", "ETH 2026-11-23"]);
  assert.equal(w.rows.length, 2);
  assert.ok(w.rows.every((r) => r.anchor_tx && sha(r.canonical) === r.commitment));
  const again = await runDailyV2(w.deps); // a second run the same day changes nothing
  assert.equal(again.commits.length, 0);
  assert.equal(again.skipped.length, 2);
  assert.equal(w.rows.length, 2);
});

test("daily v2: a failed commit keeps the row and retries with the same canonical", async () => {
  const now = ms("2026-11-24") + 20 * 60_000;
  const w = world(now);
  let fail = true;
  const commit = w.deps.commit;
  w.deps.commit = async (a, d, c) => {
    if (fail && a === "BTC") throw new Error("node down");
    return commit(a, d, c);
  };
  const first = await runDailyV2(w.deps);
  assert.equal(first.errors.length, 1);
  const btc = w.rows.find((r) => r.asset === "BTC")!;
  assert.equal(btc.anchor_tx, null);
  fail = false;
  await runDailyV2(w.deps);
  assert.equal(w.rows.filter((r) => r.asset === "BTC").length, 1);
  assert.equal(w.slots.get("BTC|2026-11-23")!.commitment, btc.commitment);
});

test("daily v2: reveals only after the horizon, and only rows the chain still has unrevealed", async () => {
  const t0 = ms("2026-11-24") + 20 * 60_000;
  const w = world(t0);
  await runDailyV2(w.deps);
  w.sent.length = 0;
  w.deps.now = t0 + 7 * DAY + 30_000; // horizon + 30 s: still too early (one-minute margin)
  await runDailyV2({ ...w.deps, assets: [] });
  assert.equal(w.sent.filter((s) => s.startsWith("reveal")).length, 0);
  w.deps.now = t0 + 7 * DAY + 2 * 60_000;
  const out = await runDailyV2({ ...w.deps, assets: [] });
  assert.equal(out.reveals.length, 2);
});

test("daily v2: the tx is recorded as soon as it is sent, so a failed wait does not freeze the row", async () => {
  const now = ms("2026-11-24") + 20 * 60_000;
  const w = world(now);
  const commit = w.deps.commit;
  w.deps.commit = async (a, d, c, onSent) => {
    await commit(a, d, c, onSent); // sent and recorded…
    throw new Error("waitForTransactionFinalization timed out"); // …but the wait failed
  };
  await runDailyV2(w.deps);
  assert.ok(w.rows.every((r) => r.anchor_tx)); // the next run sees the slot and a recorded tx
  w.deps.commit = commit;
  const next = await runDailyV2(w.deps);
  assert.deepEqual(next.errors, []);
});

test("daily v2: a chain rejection clears the recorded tx", async () => {
  const { RejectedError } = await import("../src/contract-v2.ts");
  const now = ms("2026-11-24") + 20 * 60_000;
  const w = world(now);
  w.deps.commit = async (_a, _d, _c, onSent) => {
    await onSent?.("tx-bad");
    throw new RejectedError("commit rejected (tx-bad): RejectedReceive code -11");
  };
  const out = await runDailyV2(w.deps);
  assert.equal(out.errors.length, 2);
  assert.ok(w.rows.every((r) => r.anchor_tx === null));
  assert.ok(out.errors.every((e) => !e.includes("momentum_e6"))); // no canonical in the log
});

test("daily v2: two overlapping runs keep one canonical per day", async () => {
  const now = ms("2026-11-24") + 20 * 60_000;
  const w = world(now);
  let n = 0;
  const nonces = () => (n++ % 2 ? "f".repeat(32) : "e".repeat(32));
  await Promise.all([runDailyV2({ ...w.deps, nonce: nonces }), runDailyV2({ ...w.deps, nonce: nonces })]);
  assert.equal(w.rows.filter((r) => r.asset === "BTC").length, 1);
  assert.equal(w.slots.get("BTC|2026-11-23")!.commitment, w.rows.find((r) => r.asset === "BTC")!.commitment);
});

test("daily v2: an on-chain commitment missing from the database is reported", async () => {
  const now = ms("2026-11-24") + 20 * 60_000;
  const w = world(now);
  w.slots.set("BTC|2026-11-23", { commitment: "ff".repeat(32), committed_at: new Date(now).toISOString(), reveal: null });
  const out = await runDailyV2(w.deps);
  assert.ok(out.errors.some((e) => /not in the database/.test(e)));
});
