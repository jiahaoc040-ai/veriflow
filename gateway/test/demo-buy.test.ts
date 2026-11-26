/**
 * Live demo button: limits and the shape of what the page shows. Fake agent, no network beyond localhost
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { demoBuyRouter, demoDisabledRouter } from "../src/demo-buy.ts";

function serve(router: express.Router) {
  const app = express(); app.use(express.json()); app.use(router);
  return new Promise<{ url: string; close: () => void }>((ok) => { const s = app.listen(0, () => ok({ url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => s.close() })); });
}
const post = (url: string, asset = "BTC") => fetch(`${url}/demo/buy`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ asset }) });
const okAgent = (calls: string[], delay = 0) => ({
  address: "4Vf4", agentTokenId: "1478",
  buySignal: async (a: string) => {
    calls.push(a); await new Promise((r) => setTimeout(r, delay));
    return { status: 200, refused: false, paymentExplorer: "https://x/tx/abc", sellerCheck: { ok: true, payTo: "3WSA", tokenId: "1313", checks: [{ name: "c1", ok: true, detail: "d" }] },
      body: { canonical: '{"asset":"BTC"}', commitment: "aa", anchor_tx: "bb", buyer_agent: { token_id: "1478", checked: "ok" } } };
  },
});

test("one purchase returns the seller checks, payment, the call and its commit", async () => {
  const calls: string[] = [];
  const s = await serve(demoBuyRouter({ makeAgent: () => okAgent(calls) }));
  const j = await (await post(s.url, "eth")).json();
  s.close();
  assert.deepEqual(calls, ["ETH"]);
  assert.equal(j.seller_check.ok, true);
  assert.equal(j.payment_tx, "https://x/tx/abc");
  assert.equal(j.canonical, '{"asset":"BTC"}');
  assert.match(j.commit_tx_url, /\/transaction\/bb$/);
  assert.equal(j.seller_checked_buyer.token_id, "1478");
});

test("limits: unknown asset, per visitor per hour, site-wide per day, one at a time", async () => {
  const calls: string[] = [];
  let t = Date.parse("2026-11-26T10:00:00Z");
  const s = await serve(demoBuyRouter({ makeAgent: () => okAgent(calls), perIpPerHour: 2, dailyLimit: 3, now: () => t, ipOf: (q) => String(q.headers["x-test-ip"] ?? "a") }));
  assert.equal((await post(s.url, "DOGE")).status, 400);
  assert.equal((await post(s.url)).status, 200);
  assert.equal((await post(s.url)).status, 200);
  assert.equal((await post(s.url)).status, 429); // third from the same visitor this hour
  const other = (ip: string) => fetch(`${s.url}/demo/buy`, { method: "POST", headers: { "content-type": "application/json", "x-test-ip": ip }, body: "{}" });
  assert.equal((await other("b")).status, 200);
  const r = await other("c");
  assert.equal(r.status, 429); // site-wide daily limit reached
  assert.equal((await r.json()).error, "daily_limit");
  t += 24 * 3600_000; // next UTC day
  assert.equal((await other("c")).status, 200);
  s.close();
  assert.equal(calls.length, 4);
});

test("a second visitor while a purchase runs gets busy, not a double payment", async () => {
  const calls: string[] = [];
  const s = await serve(demoBuyRouter({ makeAgent: () => okAgent(calls, 300), ipOf: () => String(Math.random()) }));
  const [a, b] = await Promise.all([post(s.url), new Promise((r) => setTimeout(r, 50)).then(() => post(s.url))]);
  s.close();
  assert.equal(a.status, 200);
  assert.equal(b.status, 429);
  assert.equal(calls.length, 1);
});

test("not configured: status says disabled and buying is refused", async () => {
  const s = await serve(demoDisabledRouter());
  assert.deepEqual(await (await fetch(`${s.url}/demo/status`)).json(), { enabled: false });
  assert.equal((await post(s.url)).status, 503);
  s.close();
});
