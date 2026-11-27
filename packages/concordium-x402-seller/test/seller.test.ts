/** The seller hooks on a stand-in x402 server: no network, fake node reads */
import { test } from "node:test";
import assert from "node:assert/strict";
import { namedAgentOf } from "concordium-x402-guard";
import { concordiumSeller, sellerAgentExtension } from "../src/seller.ts";
import { matchesPayment } from "../src/recovery.ts";
import { memoryLedger } from "../src/ledger.ts";
import { eligibilityHandlers } from "../src/http.ts";
import { EligibilityService, EligibilityStore } from "../src/eligibility.ts";
import { NETWORKS } from "../src/networks.ts";

const NET = NETWORKS.testnet.caip2;
const PAYER = "2xBpaHottqhwFZURMZW4uZduQvpxNDSy46iXMYs9kceNGaPpZX";
const OTHER = "2xdTv8awN1BjgYEw8W1BVXVtiEwG2b29U8KoZQqJrDuEqddseE";
const PAYTO = "4J2SFgeVrLHVqPkb3dczpYKP99wFMm7FDFp3fEPwXMff3ieLi2";
const TX = "ab".repeat(32);

function fakeServer() {
  const h: Record<string, (ctx: any) => Promise<any>> = {};
  const server = {
    onBeforeVerify: (f: any) => ((h.verify = f), server),
    onBeforeSettle: (f: any) => ((h.settle = f), server),
    onSettleFailure: (f: any) => ((h.failure = f), server),
    onAfterSettle: (f: any) => ((h.after = f), server),
  };
  return { server, h };
}
const ctx = (o: { payer?: string; header?: string; network?: string; asset?: string; amount?: string } = {}) => ({
  paymentPayload: { payload: { signedTransaction: { header: { sender: o.payer ?? PAYER } } } },
  requirements: { network: o.network ?? NET, payTo: PAYTO, amount: o.amount ?? "1000000", asset: o.asset ?? "CCD" },
  transportContext: { request: { adapter: { getHeader: (n: string) => (n.toLowerCase() === "x-concordium-agent" ? o.header : undefined) } } },
});
const agent = (wallet = PAYER, status: "Active" | "Revoked" = "Active") => async (id: string) => ({ tokenId: id, owner: OTHER, wallet, status, agentUri: null, metadataHash: null });
const quiet = () => {};

test("eligibility is re-checked for every payment; a failed re-check refuses before verification", async () => {
  let calls = 0;
  const { server, h } = fakeServer();
  concordiumSeller(server, { log: quiet, readAgent: agent(), verifyUrl: "https://seller.test/verify", eligibility: { async recheck(a) { calls++; if (a !== PAYER) throw new Error("no proof"); } } });
  assert.equal(await h.verify(ctx()), undefined);
  assert.equal(await h.verify(ctx()), undefined);
  assert.equal(calls, 2, "never cached");
  const r = await h.verify(ctx({ payer: OTHER }));
  assert.equal(r.abort, true);
  assert.equal(r.reason, "buyer_proof_required");
  assert.match(r.message, /seller\.test\/verify/);
});

test("payments on another network are left alone", async () => {
  const { server, h } = fakeServer();
  concordiumSeller(server, { log: quiet, eligibility: { async recheck() { throw new Error("must not run"); } } });
  assert.equal(await h.verify(ctx({ network: "eip155:8453" })), undefined);
});

test("buyer agent: named agent must be Active with the payer as agentWallet, checked before verify and again before settle", async () => {
  let wallet = PAYER;
  const { server, h } = fakeServer();
  concordiumSeller(server, { log: quiet, readAgent: async (id) => agent(wallet)(id) });
  assert.equal(await h.verify(ctx({ header: "1478" })), undefined);
  wallet = OTHER; // re-pointed between verify and settle
  const r = await h.settle(ctx({ header: "1478" }));
  assert.equal(r.reason, "buyer_agent_check_failed:wallet_mismatch");
  assert.equal((await h.verify(ctx({ header: "x1" }))).reason, "buyer_agent_check_failed:bad_id");
});

test("buyer agent policy: required refuses an unnamed buyer, off ignores the header", async () => {
  const a = fakeServer();
  concordiumSeller(a.server, { log: quiet, buyerAgent: "required", readAgent: agent() });
  assert.equal((await a.h.verify(ctx())).reason, "buyer_agent_check_failed:missing");
  const b = fakeServer();
  concordiumSeller(b.server, { log: quiet, buyerAgent: "off", readAgent: async () => { throw new Error("must not read"); } });
  assert.equal(await b.h.verify(ctx({ header: "1478" })), undefined);
  const c = fakeServer();
  concordiumSeller(c.server, { log: quiet, readAgent: agent(PAYER, "Revoked") });
  assert.equal((await c.h.verify(ctx({ header: "1478" }))).reason, "buyer_agent_check_failed:not_active");
});

function fakeGrpc(summary: unknown) {
  return {
    async waitForTransactionFinalization() { return {}; },
    async getBlockItemStatus() { return { status: "finalized", outcome: { summary } }; },
  } as never;
}
const ccdTransfer = (from: string, to: string, amount: bigint) => ({ type: "accountTransaction", transactionType: "transfer", sender: from, transfer: { to, amount } });

test("a settlement reported as failed is recovered only on an exact on-chain match, and only once", async () => {
  const { server, h } = fakeServer();
  const ledger = memoryLedger();
  concordiumSeller(server, { log: quiet, ledger, grpc: fakeGrpc(ccdTransfer(PAYER, PAYTO, 1_000_000n)) });
  const failure = { ...ctx(), error: { transaction: TX, errorReason: "finalization_failed" } };
  const r = await h.failure(failure);
  assert.equal(r.recovered, true);
  assert.equal(r.result.transaction, TX);
  assert.equal(await h.failure(failure), undefined, "the same transaction is not delivered twice");
  await assert.rejects(h.after({ result: { transaction: TX } }), /already delivered/);

  const wrong = fakeServer();
  concordiumSeller(wrong.server, { log: quiet, grpc: fakeGrpc(ccdTransfer(PAYER, PAYTO, 999_999n)) });
  assert.equal(await wrong.h.failure({ ...ctx(), error: { transaction: TX } }), undefined);
  const off = fakeServer();
  concordiumSeller(off.server, { log: quiet, recover: false, grpc: fakeGrpc(ccdTransfer(PAYER, PAYTO, 1_000_000n)) });
  assert.equal(await off.h.failure({ ...ctx(), error: { transaction: TX } }), undefined);
});

test("after settle: first delivery passes, a repeat of the same transaction is failed closed", async () => {
  const { server, h } = fakeServer();
  concordiumSeller(server, { log: quiet });
  await h.after({ result: { transaction: "cd".repeat(32) } });
  await assert.rejects(h.after({ result: { transaction: "CD".repeat(32) } }), (e: Error) => e.name !== "" && /already/.test(e.message));
});

test("matchesPayment: CCD and PLT, payer, payTo and exact amount", () => {
  assert.deepEqual(matchesPayment(ccdTransfer(PAYER, PAYTO, 5n), PAYER, PAYTO, "5", "CCD"), { ok: true });
  assert.equal(matchesPayment(ccdTransfer(OTHER, PAYTO, 5n), PAYER, PAYTO, "5", "CCD").ok, false);
  assert.equal(matchesPayment({ ...ccdTransfer(PAYER, PAYTO, 5n), transactionType: "failed" }, PAYER, PAYTO, "5", "CCD").ok, false);
  const plt = { type: "accountTransaction", transactionType: "tokenUpdate", sender: PAYER, events: [{ tag: "TokenTransfer", tokenId: { value: "hh-VFUSD" }, from: { address: PAYER }, to: { address: PAYTO }, amount: { value: "1000000" } }] };
  assert.deepEqual(matchesPayment(plt, PAYER, PAYTO, "1000000", "hh-VFUSD"), { ok: true });
  assert.equal(matchesPayment(plt, PAYER, PAYTO, "1000000", "EURR").ok, false);
  assert.equal(matchesPayment(plt, PAYER, PAYTO, "1", "hh-VFUSD").ok, false);
});

test("the seller's 402 extension is exactly what the buyer's guard reads", () => {
  const ext = sellerAgentExtension({ network: "testnet", tokenId: 1313, badge: "JyP9Y5PqyaZge2fzDzyQa" });
  assert.equal(namedAgentOf({ extensions: ext } as never, NET, "12802.0"), "1313|JyP9Y5PqyaZge2fzDzyQa");
  assert.equal(namedAgentOf({ extensions: sellerAgentExtension({ network: "mainnet", tokenId: 5 }) } as never, NET, "12802.0"), "mismatch");
});

test("eligibility endpoints: a bad address never reaches the chain; status never shows the credential or the proof", async () => {
  const chain = { async identityProviders() { return [0]; }, async anchorRequest() { throw new Error("must not anchor"); } } as never;
  const http = eligibilityHandlers(new EligibilityService({ minAge: 18, restrictedCountries: ["US"] }, new EligibilityStore(), chain));
  assert.equal((await http.challenge({ account: "nope" })).status, 400);
  const s = http.status(PAYER);
  assert.equal(s.body.eligible, false);
  assert.ok(!("credId" in s.body) && !("presentationJson" in s.body));
  assert.equal((await http.verify({ id: "unknown", presentation: "{}" })).status, 403);
});

test("network names: a wrong one is a clear error", async () => {
  const { server } = fakeServer();
  assert.throws(() => concordiumSeller(server, { network: "eip155:8453" as never }), /testnet" or "mainnet/);
});

test("review fixes: proof re-checked before settle too; unreadable header refuses; other networks' settlements untouched", async () => {
  let eligible = true;
  const { server, h } = fakeServer();
  concordiumSeller(server, { log: quiet, readAgent: agent(), eligibility: { async recheck() { if (!eligible) throw new Error("revoked"); } } });
  assert.equal(await h.verify(ctx()), undefined);
  eligible = false;
  assert.equal((await h.settle(ctx())).reason, "buyer_proof_required");
  const bad = { ...ctx(), transportContext: { request: { adapter: { getHeader: () => { throw new Error("x"); } } } } };
  eligible = true;
  assert.equal((await h.verify(bad)).reason, "buyer_agent_check_failed:header_unreadable");
  await h.after({ result: { transaction: "ee".repeat(32) }, requirements: { ...ctx().requirements, network: "eip155:8453" } });
  await h.after({ result: { transaction: "ee".repeat(32) }, requirements: { ...ctx().requirements, network: "eip155:8453" } });
});

test("review fixes: hash found in the error message; ledger down still delivers a matching recovery", async () => {
  const { server, h } = fakeServer();
  const down = { async claim(): Promise<boolean> { throw new Error("db down"); } };
  concordiumSeller(server, { log: quiet, ledger: down, grpc: fakeGrpc(ccdTransfer(PAYER, PAYTO, 1_000_000n)) });
  const r = await h.failure({ ...ctx(), error: { transaction: "", errorReason: `transaction ${TX} not found` } });
  assert.equal(r.recovered, true);
  assert.equal(r.result.transaction, TX);
  assert.equal(await h.failure({ ...ctx(), error: { errorReason: "timeout" } }), undefined, "no hash: nothing to read, nothing delivered");
});

test("review fixes: recovery matches only a plain transfer; PLT by net amount", () => {
  assert.equal(matchesPayment({ ...ccdTransfer(PAYER, PAYTO, 5n), transactionType: "update" }, PAYER, PAYTO, "5", "CCD").ok, false);
  assert.equal(matchesPayment({ ...ccdTransfer(PAYER, PAYTO, 5n), transactionType: "transferWithMemo" }, PAYER, PAYTO, "5", "CCD").ok, true);
  const ev = (from: string, to: string, v: string) => ({ tag: "TokenTransfer", tokenId: { value: "T" }, from: { address: from }, to: { address: to }, amount: { value: v } });
  const plt = (events: unknown[]) => ({ type: "accountTransaction", transactionType: "tokenUpdate", sender: PAYER, events });
  assert.equal(matchesPayment(plt([ev(PAYER, PAYTO, "10"), ev(PAYTO, PAYER, "5")]), PAYER, PAYTO, "10", "T").ok, false, "money sent back does not count");
  assert.equal(matchesPayment(plt([ev(PAYER, PAYTO, "4"), ev(PAYER, PAYTO, "6")]), PAYER, PAYTO, "10", "T").ok, true);
  assert.equal(matchesPayment({ ...plt([ev(PAYER, PAYTO, "10")]), sender: OTHER }, PAYER, PAYTO, "10", "T").ok, false);
});

test("buyerRequirementsExtra: where a refused buyer can verify", async () => {
  const { buyerRequirementsExtra } = await import("../src/seller.ts");
  assert.deepEqual(buyerRequirementsExtra({ verifyUrl: "https://s.test/verify", buyerAgent: "required" }), { buyerProofUrl: "https://s.test/verify", buyerAgentHeader: "X-Concordium-Agent", buyerAgentPolicy: "required" });
});
