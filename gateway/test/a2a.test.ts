/**
 * A2A 端點（POST /a2a，JSON-RPC message/send）：路由規則與完整請求，賣方網站用假的伺服器代替
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { mountA2A, route } from "../src/a2a.ts";

const WALLET = "3WSAJwTZqVRypnGMkUjW28QDES8h1FUBoCwrzQ1rdN35NGavf8";
const C1 = "ab".repeat(32);
let seller: Server;
let hosted: Server;
let base = "";
const listen = (s: Server) => new Promise<string>((ok) => s.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));
const text = (t: string) => ({ role: "user", messageId: "m1", parts: [{ kind: "text", text: t }] });

before(async () => {
  seller = createServer((req, res) => {
    const send = (code: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/track-record") return send(200, { issued: 4, signal_days: 2, scored: 0, hit_rate: null });
    if (req.url === "/commitments") return send(200, [{ commitment: C1, asset: "ETH", anchor_tx: null }]);
    if (req.url === `/commitments/${C1}`) return send(200, { commitment: C1, anchor_tx: null });
    if (req.url === `/eligibility/${WALLET}`) return send(200, { eligible: false });
    if (req.url === "/signal/BTC") {
      const required = { x402Version: 2, accepts: [{ scheme: "exact", amount: "1000000", asset: "CCD", payTo: WALLET }] };
      return send(402, {}, { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64") });
    }
    send(404, {});
  });
  const sellerUrl = await listen(seller);
  const app = express();
  app.use(express.json());
  mountA2A(app, { selfUrl: sellerUrl, publicUrl: "https://veriflow.example" });
  hosted = createServer(app);
  base = await listen(hosted);
});

after(() => {
  seller?.close();
  hosted?.close();
});

async function send(body: unknown) {
  const r = await fetch(`${base}/a2a`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return (await r.json()) as { result?: { kind: string; role: string; contextId: string; parts: { kind: string; text?: string; data?: any }[] }; error?: { code: number } };
}
const call = (message: unknown) => send({ jsonrpc: "2.0", id: 7, method: "message/send", params: { message } });

test("routing: explicit skill wins, otherwise keywords and ids in the text", () => {
  assert.equal(route(text("What is your track record?")).skill, "track_record");
  assert.equal(route(text("list your on-chain commitments")).skill, "commitments");
  assert.deepEqual(route(text(`please verify ${C1}`)), { skill: "verify_signal", commitment: C1, canonical: undefined });
  assert.equal(route(text(`is ${WALLET} eligible?`)).account, WALLET);
  assert.equal(route(text("how much does a signal cost?")).skill, "how_to_buy");
  assert.equal(route(text("hello")).skill, "help");
  assert.equal(route({ parts: [{ kind: "data", data: { skill: "commitments" } }, { kind: "text", text: "track record" }] }).skill, "commitments");
  assert.equal(route({ parts: [{ kind: "data", data: { skill: "rm -rf" } }] }).skill, "help");
});

test("message/send returns an agent message with a text summary and the full result as data", async () => {
  const r = await call({ ...text("track record please"), contextId: "ctx-1" });
  assert.equal(r.result?.kind, "message");
  assert.equal(r.result?.role, "agent");
  assert.equal(r.result?.contextId, "ctx-1");
  assert.match(r.result?.parts[0].text ?? "", /hit rate/);
  assert.equal(r.result?.parts[1].data.signal_days, 2);
});

test("how_to_buy returns the live x402 terms; eligibility points to the ZK verification page", async () => {
  const buy = await call(text("how do I buy a signal?"));
  assert.equal(buy.result?.parts[1].data.accepts[0].payTo, WALLET);
  const elig = await call(text(`is ${WALLET} eligible?`));
  assert.match(elig.result?.parts[0].text ?? "", /veriflow\.example\/verify\?account=/);
  const unanchored = await call(text(`verify ${C1}`));
  assert.match(unanchored.result?.parts[0].text ?? "", /not been anchored/);
});

test("JSON-RPC errors: bad request, unknown method, missing message; GET is not allowed", async () => {
  assert.equal((await send({ hello: 1 })).error?.code, -32600);
  assert.equal((await send({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: {} })).error?.code, -32601);
  assert.equal((await send({ jsonrpc: "2.0", id: 1, method: "message/send", params: {} })).error?.code, -32602);
  assert.equal((await fetch(`${base}/a2a`)).status, 405);
});
