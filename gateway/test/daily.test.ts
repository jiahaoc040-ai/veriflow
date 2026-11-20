/**
 * 每日公開訊號排程：用假的 API 與假的上鏈，不需要網路
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { runDailyOnce } from "../src/daily.ts";

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
