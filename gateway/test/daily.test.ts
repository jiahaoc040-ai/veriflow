/**
 * 每日公開訊號排程：用假的 API 與假的上鏈，不需要網路
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runDailyOnce, runRevealsOnce } from "../src/daily.ts";

type Call = { url: string; body?: string; secret?: string };

function fakeApi(daily: Record<string, unknown>, anchorStatus = 200) {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, body: init?.body as string | undefined, secret: h["X-VeriFlow-Gateway"] });
    if (url.includes("/daily/")) {
      const asset = url.split("/daily/")[1];
      const b = daily[asset];
      return b ? new Response(JSON.stringify(b)) : new Response("{}", { status: 404 });
    }
    return new Response("{}", { status: anchorStatus });
  }) as typeof fetch;
  return { f, calls };
}

test("new and retry signals are anchored and reported; existing ones are skipped", async () => {
  const { f, calls } = fakeApi({
    BTC: { status: "new", as_of: "2026-11-19", commitment: "c1" },
    ETH: { status: "exists", as_of: "2026-11-19" },
    SOL: { status: "retry", as_of: "2026-11-19", commitment: "c3" },
  });
  const anchored: string[] = [];
  const out = await runDailyOnce({
    apiUrl: "http://api", secret: "s", assets: ["BTC", "ETH", "SOL"], fetch: f,
    anchor: async (c) => { anchored.push(c); return `tx-${c}`; },
  });
  assert.deepEqual(anchored, ["c1", "c3"]);
  assert.deepEqual(out.map((r) => r.status), ["anchored", "exists", "anchored"]);
  assert.ok(calls.every((c) => c.secret === "s"));
  const reports = calls.filter((c) => c.url.endsWith("/anchor"));
  assert.deepEqual(reports.map((c) => [c.url, JSON.parse(c.body!).anchor_tx]), [
    ["http://api/commitments/c1/anchor", "tx-c1"],
    ["http://api/commitments/c3/anchor", "tx-c3"],
  ]);
});

test("a failed anchor on one asset does not stop the others, and is not reported", async () => {
  const { f, calls } = fakeApi({
    BTC: { status: "new", as_of: "d", commitment: "c1" },
    ETH: { status: "new", as_of: "d", commitment: "c2" },
  });
  const logs: string[] = [];
  const out = await runDailyOnce({
    apiUrl: "http://api", secret: "s", assets: ["BTC", "ETH"], fetch: f, log: (m) => logs.push(m),
    anchor: async (c) => { if (c === "c1") throw new Error("node down"); return "tx"; },
  });
  assert.deepEqual(out.map((r) => r.status), ["error", "anchored"]);
  assert.match(out[0].error!, /node down/);
  assert.ok(!calls.some((c) => c.url.includes("/c1/anchor")));
  assert.ok(logs.some((m) => /retry next round/.test(m)));
});

test("API errors are reported per asset without anchoring", async () => {
  const { f } = fakeApi({});
  let anchored = 0;
  const out = await runDailyOnce({
    apiUrl: "http://api", secret: "s", assets: ["DOGE"], fetch: f,
    anchor: async () => { anchored++; return "tx"; },
  });
  assert.equal(anchored, 0);
  assert.equal(out[0].status, "error");
  assert.match(out[0].error!, /404/);
});

// ── 到期自動公開 ──
const DAY = 86_400_000;
const T0 = Date.parse("2026-11-20T05:00:00Z");

function revealWorld(records: Record<string, { committed_at: string; reveal: unknown | null } | null | "down">) {
  const rows = [
    { commitment: "a".repeat(64), anchor_tx: "t1" },
    { commitment: "b".repeat(64), anchor_tx: "t2" },
    { commitment: "c".repeat(64), anchor_tx: null },
    { commitment: "d".repeat(64), anchor_tx: "t4" },
  ];
  const f = (async (url: string) => {
    if (url === "http://api/commitments") return new Response(JSON.stringify(rows));
    const c = url.split("/commitments/")[1];
    return new Response(JSON.stringify({ canonical: `{"c":"${c[0]}"}` }));
  }) as typeof fetch;
  const revealed: string[] = [];
  return {
    revealed,
    deps: {
      apiUrl: "http://api",
      fetch: f,
      record: async (c: string) => {
        const r = records[c[0]];
        if (r === "down") throw new Error("node unreachable");
        return r ?? null;
      },
      reveal: async (canonical: string) => {
        revealed.push(canonical);
        return `tx-${canonical}`;
      },
    },
  };
}

test("reveal: only contract commitments past the 7-day horizon and not yet revealed", async () => {
  const w = revealWorld({
    a: { committed_at: new Date(T0).toISOString(), reveal: null }, // 到期 → 公開
    b: { committed_at: new Date(T0 + 3 * DAY).toISOString(), reveal: null }, // 還沒到期
    d: { committed_at: new Date(T0).toISOString(), reveal: { signal: "RISK_ON" } }, // 已公開
  });
  const out = await runRevealsOnce({ ...w.deps, now: () => T0 + 7 * DAY + 2 * 60_000 });
  assert.deepEqual(out.map((r) => r.status), ["revealed"]);
  assert.deepEqual(w.revealed, ['{"c":"a"}']);
});

test("reveal: not before horizon + 1 minute; register-data commitments and node outages are skipped", async () => {
  const early = revealWorld({ a: { committed_at: new Date(T0).toISOString(), reveal: null } });
  assert.deepEqual(await runRevealsOnce({ ...early.deps, now: () => T0 + 7 * DAY + 30_000 }), []);
  const skip = revealWorld({ a: null, b: "down", d: null });
  assert.deepEqual(await runRevealsOnce({ ...skip.deps, now: () => T0 + 30 * DAY }), []);
});

test("reveal: a failing reveal is reported and retried next round; at most max per round", async () => {
  const old = { committed_at: new Date(T0).toISOString(), reveal: null };
  const w = revealWorld({ a: old, b: old, d: old });
  const logs: string[] = [];
  let n = 0;
  const out = await runRevealsOnce({
    ...w.deps,
    now: () => T0 + 10 * DAY,
    max: 2,
    log: (m) => logs.push(m),
    reveal: async (c) => {
      if (n++ === 0) throw new Error("TooEarly");
      return `tx-${c}`;
    },
  });
  assert.deepEqual(out.map((r) => r.status), ["error", "revealed"]);
  assert.ok(logs.some((m) => /retry next round/.test(m)));
});
