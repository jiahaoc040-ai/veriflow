/**
 * Buying a signal through the escrow: quote → (pay, release on chain) → deliver. Fake escrow reads, no network
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { escrowSale } from "../src/escrow-sale.ts";
import type { EscrowRecord } from "../src/escrow.ts";

const SELLER = "3WSAJwTZqVRypnGMkUjW28QDES8h1FUBoCwrzQ1rdN35NGavf8";
const BUYER = "4Vf4buyer000000000000000000000000000000000000000000".slice(0, 50);
const OTHER = "4Hgaother000000000000000000000000000000000000000000".slice(0, 50);

function setup(o: { eligible?: boolean; t0?: number } = {}) {
  let t = o.t0 ?? Date.parse("2026-11-29T10:00:00Z");
  const escrows = new Map<bigint, EscrowRecord>();
  let served = 0;
  const sale = escrowSale({
    contract: "<13171,0>",
    explorer: "https://x",
    tokenId: 1313n,
    payTo: SELLER,
    priceMicroCcd: 1_000_000n,
    secret: Buffer.from("test-secret"),
    readEscrow: async (id) => escrows.get(id) ?? null,
    serveSignal: async (asset) => { served++; return { status: 200, body: { signal: { asset, regime: "RISK_ON" }, commitment: "c0ffee" } }; },
    isAccount: (a) => a.length === 50,
    checkBuyer: async () => (o.eligible === false ? { ok: false, reason: "buyer_proof_required", message: "verify first" } : { ok: true }),
    now: () => t,
  });
  const put = (id: bigint, e: Partial<EscrowRecord> & { memo: string }) =>
    escrows.set(id, { buyer: BUYER, tokenId: "1313", amountMicroCcd: 1_000_000n, paidAt: new Date(t), claimAfter: new Date(t + 600_000), walletAtPay: SELLER, state: "Released", paidTo: SELLER, ...e });
  return { sale, put, advance: (ms: number) => (t += ms), served: () => served };
}

async function quoted(s: ReturnType<typeof setup>, asset = "BTC", buyer = BUYER) {
  const q = await s.sale.quote(asset, buyer);
  assert.equal(q.ok, true);
  if (!q.ok) throw new Error("no quote");
  return q.quote;
}

test("quote names the contract, the agent and the price; memo is short enough for the contract", async () => {
  const s = setup();
  const q = await quoted(s, "btc");
  assert.equal(q.contract, "<13171,0>");
  assert.equal(q.token_id, "1313");
  assert.equal(q.amount_micro_ccd, "1000000");
  assert.match(q.memo, /^vf1:BTC:/);
  assert.ok(Buffer.byteLength(q.memo) <= 64);
  assert.match(q.claim_token, /^[0-9a-f]{32}$/);
});

test("no quote without the buyer's proof, or for malformed input", async () => {
  assert.deepEqual((await setup({ eligible: false }).sale.quote("BTC", BUYER)).ok, false);
  const s = setup();
  const bad = await s.sale.quote("BTC", "nope");
  assert.equal(bad.ok, false);
  assert.equal((await s.sale.quote("B$C", BUYER)).ok, false);
});

test("released to the seller with the quote's memo by the quoted buyer: delivered, and again on retry", async () => {
  const s = setup();
  const q = await quoted(s);
  s.put(7n, { memo: q.memo });
  const d = await s.sale.deliver("BTC", "7", q.claim_token);
  assert.equal(d.status, 200);
  assert.equal((d.body.payment as any).via, "escrow");
  assert.equal((d.body.payment as any).paid_to, SELLER);
  assert.equal((d.body.signal as any).asset, "BTC");
  assert.equal((await s.sale.deliver("BTC", "7", q.claim_token)).status, 200);
});

test("still held: not delivered until the buyer releases (the buyer could otherwise refund)", async () => {
  const s = setup();
  const q = await quoted(s);
  s.put(1n, { memo: q.memo, state: "Held", paidTo: null });
  const d = await s.sale.deliver("BTC", "1", q.claim_token);
  assert.equal(d.status, 409);
  assert.equal(d.body.error, "not_released");
  assert.equal(s.served(), 0);
});

test("someone watching the chain cannot collect: wrong claim token, other payer, other asset", async () => {
  const s = setup();
  const q = await quoted(s);
  s.put(2n, { memo: q.memo });
  assert.equal((await s.sale.deliver("BTC", "2", "0".repeat(32))).status, 403);
  assert.equal((await s.sale.deliver("ETH", "2", q.claim_token)).status, 403);
  s.put(3n, { memo: q.memo, buyer: OTHER });
  assert.equal((await s.sale.deliver("BTC", "3", q.claim_token)).body.error, "not_your_purchase");
  assert.equal(s.served(), 0);
});

test("the payment itself must be right: agent, recorded wallet, amount, payout, not refunded", async () => {
  const s = setup();
  const q = await quoted(s);
  s.put(4n, { memo: q.memo, tokenId: "11" });
  s.put(5n, { memo: q.memo, walletAtPay: OTHER, paidTo: OTHER });
  s.put(6n, { memo: q.memo, amountMicroCcd: 999_999n });
  s.put(8n, { memo: q.memo, state: "Refunded", paidTo: BUYER });
  for (const id of ["4", "5", "6"]) assert.equal((await s.sale.deliver("BTC", id, q.claim_token)).body.error, "wrong_payment", id);
  assert.equal((await s.sale.deliver("BTC", "8", q.claim_token)).status, 410);
  assert.equal((await s.sale.deliver("BTC", "99", q.claim_token)).status, 404);
  assert.equal(s.served(), 0);
});

test("paid after the quote expired, or collected after the window: refused", async () => {
  const s = setup();
  const q = await quoted(s);
  s.advance(16 * 60_000);
  s.put(9n, { memo: q.memo });
  assert.equal((await s.sale.deliver("BTC", "9", q.claim_token)).body.error, "quote_expired");
  const s2 = setup();
  const q2 = await quoted(s2);
  s2.put(10n, { memo: q2.memo });
  s2.advance(25 * 3600_000);
  assert.equal((await s2.sale.deliver("BTC", "10", q2.claim_token)).body.error, "delivery_window_over");
});
