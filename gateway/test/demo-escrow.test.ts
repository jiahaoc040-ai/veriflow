/**
 * Escrow demo button: the three steps, the module pin, the shared lock and the limits. Fake chain, no network beyond localhost
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { escrowDemoRouter, escrowDemoDisabledRouter, type EscrowDemoChain } from "../src/demo-escrow.ts";
import { transfersOf } from "../src/escrow.ts";

function serve(router: express.Router) {
  const app = express(); app.use(express.json()); app.use(router);
  return new Promise<{ url: string; close: () => void }>((ok) => { const s = app.listen(0, () => ok({ url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, close: () => s.close() })); });
}
const post = (url: string, headers: Record<string, string> = {}) => fetch(`${url}/demo/escrow`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });

const WALLET = "3WSAJwTZqVRypnGMkUjW28QDES8h1FUBoCwrzQ1rdN35NGavf8";
function fakeChain(calls: string[], o: { module?: string; payTo?: string; delay?: number } = {}): EscrowDemoChain {
  let memo = "";
  let state = "Held";
  return {
    contract: "<1,0>", explorer: "https://x", buyer: "4Vf4",
    moduleOf: async () => o.module ?? "good",
    wouldAccept: async (id) => { calls.push(`check ${id}`); return id === 1313n ? { ok: true } : { ok: false, code: id === 11n ? -3 : id === 53n ? -4 : -2, error: id === 11n ? "AgentNotActive" : id === 53n ? "AgentHasNoWallet" : "AgentNotFound" }; },
    pay: async (id, micro, _m, m) => { calls.push(`pay ${id} ${micro}`); memo = m; await new Promise((r) => setTimeout(r, o.delay ?? 0)); return { ok: true, hex: "aa" }; },
    idOf: async (m) => (m === memo ? 7n : null),
    read: async () => ({ state, walletAtPay: WALLET, paidTo: state === "Held" ? null : o.payTo ?? WALLET, amountMicroCcd: 1_000_000n, tokenId: "1313", claimAfter: new Date() }),
    release: async (id) => { calls.push(`release ${id}`); state = "Released"; return { ok: true, hex: "bb", transfers: [{ to: o.payTo ?? WALLET, microCcd: 1_000_000n }] }; },
  };
}

test("one run: three read-only refusals, pay, release to the wallet recorded at payment", async () => {
  const calls: string[] = [];
  const s = await serve(escrowDemoRouter({ makeChain: () => fakeChain(calls), expectedModule: "good", lock: { busy: false } }));
  const j = await (await post(s.url)).json();
  s.close();
  assert.deepEqual(calls, ["check 11", "check 53", "check 99999999", "pay 1313 1000000", "release 7"]);
  assert.deepEqual(j.refusals.map((r: any) => [r.agent, r.refused, r.error]), [["11", true, "AgentNotActive"], ["53", true, "AgentHasNoWallet"], ["99999999", true, "AgentNotFound"]]);
  assert.equal(j.pay.tx, "https://x/transaction/aa");
  assert.equal(j.pay.wallet_at_pay, WALLET);
  assert.equal(j.release.tx, "https://x/transaction/bb");
  assert.equal(j.after.state, "Released");
  assert.equal(j.paid_recorded_wallet, true);
  assert.equal(j.escrow_id, "7");
});

test("a payout to any other account is reported, not hidden", async () => {
  const s = await serve(escrowDemoRouter({ makeChain: () => fakeChain([], { payTo: "4Hga" }), expectedModule: "good", lock: { busy: false } }));
  const j = await (await post(s.url)).json();
  s.close();
  assert.equal(j.paid_recorded_wallet, false);
});

test("a contract running another module: nothing is sent", async () => {
  const calls: string[] = [];
  const s = await serve(escrowDemoRouter({ makeChain: () => fakeChain(calls, { module: "other" }), expectedModule: "good", lock: { busy: false }, log: () => {} }));
  const r = await post(s.url);
  s.close();
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error, "unexpected_module");
  assert.deepEqual(calls, []);
});

test("limits: same-origin JSON only, shared lock with the other demo, per visitor, per day", async () => {
  const lock = { busy: false };
  let t = Date.parse("2026-11-27T10:00:00Z");
  const s = await serve(escrowDemoRouter({ makeChain: () => fakeChain([]), expectedModule: "good", lock, perIpPerHour: 1, dailyLimit: 2, now: () => t, ipOf: (q) => String(q.headers["x-test-ip"] ?? "a") }));
  assert.equal((await fetch(`${s.url}/demo/escrow`, { method: "POST", body: "x=1", headers: { "content-type": "application/x-www-form-urlencoded" } })).status, 403);
  assert.equal((await post(s.url, { "sec-fetch-site": "cross-site" })).status, 403);
  lock.busy = true;
  assert.equal((await post(s.url)).status, 429);
  lock.busy = false;
  assert.equal((await post(s.url)).status, 200);
  const again = await post(s.url); // same visitor: the last run again, marked, nothing sent
  assert.equal(again.status, 200);
  assert.equal((await again.json()).replay.reason, "per_ip_limit");
  assert.equal((await post(s.url, { "x-test-ip": "b" })).status, 200);
  const day = await post(s.url, { "x-test-ip": "c" });
  assert.equal(day.status, 200);
  assert.equal((await day.json()).replay.reason, "daily_limit");
  t += 24 * 3600_000;
  assert.equal((await post(s.url, { "x-test-ip": "c" })).status, 200);
  assert.equal(lock.busy, false);
  s.close();
});

test("disabled: status says so and the button stays hidden", async () => {
  const s = await serve(escrowDemoDisabledRouter());
  assert.deepEqual(await (await fetch(`${s.url}/demo/escrow/status`)).json(), { enabled: false });
  assert.equal((await post(s.url)).status, 503);
  s.close();
});

test("transfersOf reads the contract's CCD payout from a finalized summary", () => {
  const ev = { tag: "Transferred", amount: { microCcdAmount: 1000000n }, to: { address: WALLET } };
  assert.deepEqual(transfersOf({ events: [{ tag: "Updated" }, ev] }), [{ to: WALLET, microCcd: 1000000n }]);
  assert.deepEqual(transfersOf({}), []);
});
