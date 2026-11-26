/**
 * Live demo button: limits and the shape of what the page shows. Fake agent, no network beyond localhost
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { demoBuyRouter, demoDisabledRouter, memoryCounter, safeErrorCode } from "../src/demo-buy.ts";
import { readFileSync } from "node:fs";

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
  const other = (ip: string) => fetch(`${s.url}/demo/buy`, { method: "POST", headers: { "content-type": "application/json", "x-test-ip": ip }, body: JSON.stringify({ asset: "BTC" }) });
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

test("only the page can press the button: JSON body required, cross-site fetch refused, asset required", async () => {
  const calls: string[] = [];
  const s = await serve(demoBuyRouter({ makeAgent: () => okAgent(calls), ipOf: () => String(Math.random()) }));
  assert.equal((await fetch(`${s.url}/demo/buy`, { method: "POST" })).status, 403);
  assert.equal((await fetch(`${s.url}/demo/buy`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "asset=BTC" })).status, 403);
  assert.equal((await fetch(`${s.url}/demo/buy`, { method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site" }, body: '{"asset":"BTC"}' })).status, 403);
  assert.equal((await fetch(`${s.url}/demo/buy`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 400);
  s.close();
  assert.equal(calls.length, 0);
});

test("limits that are not whole numbers refuse to start (NaN would disable them)", () => {
  assert.throws(() => demoBuyRouter({ makeAgent: () => okAgent([]), dailyLimit: Number("lots") }), /DEMO_DAILY_LIMIT/);
  assert.throws(() => demoBuyRouter({ makeAgent: () => okAgent([]), perIpPerHour: -1 }), /DEMO_PER_IP_PER_HOUR/);
});

test("errors never reach the visitor: exceptions are logged, seller bodies reduced to a short code", async () => {
  const logged: string[] = [];
  const boom = { address: "x", buySignal: async () => { throw new Error("ENOENT: open '/app/gateway/keys/demo-buyer.export'"); } };
  let s = await serve(demoBuyRouter({ makeAgent: () => boom, log: (m) => logged.push(m), ipOf: () => "a" }));
  let j = await (await post(s.url)).json(); s.close();
  assert.doesNotMatch(JSON.stringify(j), /ENOENT|keys/);
  assert.match(logged.join(" "), /ENOENT/);
  const leaky = { address: "x", buySignal: async () => ({ status: 500, refused: false, body: "postgres://app:SECRET@db.internal/veriflow" }) };
  s = await serve(demoBuyRouter({ makeAgent: () => leaky, ipOf: () => "b" }));
  j = await (await post(s.url)).json(); s.close();
  assert.equal(j.error, "http_500");
  assert.equal(safeErrorCode({ error: "buyer_proof_required" }), "buyer_proof_required");
  assert.equal(safeErrorCode({ error: "postgres://app:SECRET@db" }), null);
});

test("the daily budget is shared through the counter (Postgres in production survives restarts)", async () => {
  const counter = memoryCounter();
  const make = () => serve(demoBuyRouter({ makeAgent: () => okAgent([]), counter, dailyLimit: 1, ipOf: () => String(Math.random()) }));
  let s = await make(); assert.equal((await post(s.url)).status, 200); s.close();
  s = await make(); assert.equal((await post(s.url)).status, 429); s.close(); // "restarted" router, same counter
});

test("start.sh does not leave key contents in the environment of the processes it starts", () => {
  const sh = readFileSync(new URL("../../deploy/start.sh", import.meta.url), "utf8");
  for (const v of ["FACILITATOR_KEY_JSON", "DEMO_BUYER_KEY_JSON"]) {
    const write = sh.indexOf(`"$${v}"`), unset = sh.indexOf(`unset ${v}`), start = sh.indexOf("uvicorn");
    assert.ok(write > 0 && unset > write && unset < start, `${v} must be unset after it is written and before any process starts`);
  }
});
