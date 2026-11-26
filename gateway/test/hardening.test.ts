/** Fixes from an outside security review of the gateway */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, clientKey, isSelfCall, publicMessage, scrubDetail, trustProxySetting } from "../src/security.ts";
import { memoryLedger, pgSsl, singleFlight } from "../src/once.ts";

test("single flight: concurrent requests for one commitment anchor once", async () => {
  const once = singleFlight<string>();
  let runs = 0;
  const f = async () => { runs++; await new Promise((r) => setTimeout(r, 20)); return "tx1"; };
  const all = await Promise.all(Array.from({ length: 50 }, () => once("c1", f)));
  assert.equal(runs, 1);
  assert.ok(all.every((t) => t === "tx1"));
  await once("c1", f);
  assert.equal(runs, 2, "after it finished, a later call runs again (the API then returns anchor_tx anyway)");
});

test("payment ledger: a settlement tx is delivered against once", async () => {
  const l = memoryLedger(3);
  assert.equal(await l.claim("AB"), true);
  assert.equal(await l.claim("ab"), false);
  for (const t of ["c", "d", "e"]) await l.claim(t);
  assert.equal(await l.claim("ab"), true, "bounded: the oldest is forgotten");
});

test("Postgres TLS on unless the URL disables it or is local", () => {
  assert.deepEqual(pgSsl("postgres://u:p@db.example.com/x"), { rejectUnauthorized: true });
  assert.deepEqual(pgSsl("postgres://u:p@ep-x.neon.tech/x?sslmode=require"), { rejectUnauthorized: true });
  assert.equal(pgSsl("postgres://u:p@db.example.com/x?sslmode=disable"), undefined);
  assert.equal(pgSsl("postgres://u:p@localhost:5432/x"), undefined);
});

test("rate-limit keys: IPv6 by /64, mapped IPv4 as IPv4", () => {
  assert.equal(clientKey("2001:db8:1:2:aaaa::1"), "2001:db8:1:2::/64");
  assert.equal(clientKey("2001:db8:1:2:ffff:ffff:ffff:ffff"), "2001:db8:1:2::/64");
  assert.equal(clientKey("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(clientKey("::ffff:203.0.113.9"), "203.0.113.9");
  assert.equal(clientKey("203.0.113.9"), "203.0.113.9");
  assert.equal(clientKey(undefined), "unknown");
});

test("rate limiter memory is bounded: new keys past the cap are refused, expired ones are swept", () => {
  let t = 0;
  const l = new RateLimiter(1, 1000, () => t, 3);
  assert.ok(l.take("a") && l.take("b") && l.take("c"));
  assert.equal(l.take("d"), false);
  assert.equal(l.size, 3);
  t = 5000;
  assert.equal(l.take("d"), true, "after the windows expired, the sweep makes room");
  assert.equal(l.size, 1);
});

test("TRUST_PROXY is read literally", () => {
  assert.equal(trustProxySetting(undefined), undefined);
  assert.equal(trustProxySetting("0"), undefined);
  assert.equal(trustProxySetting("false"), undefined);
  assert.equal(trustProxySetting("1"), 1);
  assert.equal(trustProxySetting("2"), 2);
  assert.throws(() => trustProxySetting("yes"));
});

test("self calls: loopback socket without X-Forwarded-For only", () => {
  assert.equal(isSelfCall({ socket: { remoteAddress: "127.0.0.1" }, headers: {} }), true);
  assert.equal(isSelfCall({ socket: { remoteAddress: "127.0.0.1" }, headers: { "x-forwarded-for": "198.51.100.1" } }), false);
  assert.equal(isSelfCall({ socket: { remoteAddress: "10.0.0.5" }, headers: {} }), false);
});

test("public error text: no URLs, hosts, addresses or paths", () => {
  const m = publicMessage(new Error("connect ECONNREFUSED 10.1.2.3:5432 at https://internal.example.com/x?k=1 reading /app/gateway/keys/facilitator.export via grpc.testnet.concordium.com:20000"));
  assert.doesNotMatch(m, /10\.1\.2\.3|internal\.example|facilitator\.export|concordium\.com|k=1/);
  assert.match(m, /ECONNREFUSED/);
  assert.ok(publicMessage("x".repeat(500)).length <= 200);
  assert.equal(publicMessage(new Error("no such account on this network: create it in the Concordium wallet first")), "no such account on this network: create it in the Concordium wallet first");
});

test("public check details keep what was compared, not raw errors", () => {
  assert.equal(scrubDetail("agent #1268, status Active (hosted registry service); node unreachable: No connection established. Last error: read ECONNRESET"), "agent #1268, status Active (hosted registry service); node unreachable (details in the server log)");
  assert.equal(scrubDetail("payTo A, on-chain agentWallet B"), "payTo A, on-chain agentWallet B");
});
