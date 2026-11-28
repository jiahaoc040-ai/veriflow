/**
 * Buy a signal through the escrow contract
 * ----------------------------------------
 * The other way to buy a signal: instead of an x402 transfer, the buyer pays into the escrow `<ESCROW_CONTRACT>`, and the
 * contract, not this server, decides where the money goes:
 *
 *   1. GET  /escrow-sale/:asset/quote?buyer=<account>
 *        The buyer's zero-knowledge proof is re-checked (as for an x402 payment). The answer names the contract, the agent
 *        (#AGENT_TOKEN_ID), the price, and a memo bound to this buyer and asset, plus a claim token only the buyer receives.
 *   2. pay      (contract): tokenId, minutes, memo, with the price attached. The contract reads CIS-8004 agentOf and holds
 *               the CCD only for an Active agent with an agentWallet, which it records.
 *   3. release  (contract, by the buyer): agentOf is read again and the CCD go to the recorded wallet, only while the
 *               registry still names it. Nothing reaches the seller unless the chain agrees, twice.
 *   4. POST /escrow-sale/:asset/deliver {escrow_id, claim_token}
 *        The server reads the escrow back from the contract: paid for this agent, to the seller's address, at least the
 *        price, by the quoted buyer with the quoted memo, and released to the seller. Only then the signal is returned.
 *
 * Delivery comes after release on purpose: while the CCD are held the buyer may still refund them, so the seller hands
 * over the signal once the contract has paid it. Delivery can be repeated (same signal record, no new payment) for
 * DELIVER_WINDOW after the quote, so a dropped connection does not lose a paid purchase.
 *
 * The memo is public on chain; the claim token is an HMAC of memo and buyer under a server secret and is never on chain,
 * so watching the chain does not let anyone else collect the signal.
 */
import express from "express";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { RateLimiter } from "./security.js";
import type { EscrowRecord } from "./escrow.js";

export type SaleBuyerCheck = (account: string) => Promise<{ ok: true; eligibility?: unknown } | { ok: false; reason: string; message: string }>;

export type EscrowSaleOptions = {
  contract: string;
  explorer: string;
  tokenId: bigint;
  payTo: string;
  priceMicroCcd: bigint;
  /** The escrow's claim window: after it, the seller's wallet may claim a payment the buyer never released */
  minutes?: number;
  secret?: Buffer;
  readEscrow: (id: bigint) => Promise<EscrowRecord | null>;
  serveSignal: (asset: string) => Promise<{ status: number; body: Record<string, unknown> }>;
  isAccount: (s: string) => boolean;
  checkBuyer?: SaleBuyerCheck;
  quoteTtlMs?: number;
  deliverWindowMs?: number;
  now?: () => number;
  ipOf?: (req: express.Request) => string | undefined;
  log?: (m: string) => void;
};

export type Quote = {
  contract: string;
  entrypoint: "pay";
  token_id: string;
  amount_micro_ccd: string;
  minutes: number;
  memo: string;
  claim_token: string;
  pay_before: string;
  pay_to_recorded_by_contract: string;
  steps: string[];
};

const ASSET = /^[A-Z]{2,10}$/;
const MEMO = /^vf1:([A-Z]{2,10}):([0-9a-z]{1,10}):([0-9a-f]{12})$/;

export function escrowSale(o: EscrowSaleOptions) {
  const now = o.now ?? Date.now;
  const secret = o.secret ?? randomBytes(32);
  const ttl = o.quoteTtlMs ?? 15 * 60_000;
  const window = o.deliverWindowMs ?? 24 * 3600_000;
  const minutes = o.minutes ?? 10;
  const log = o.log ?? ((m: string) => console.error(m));
  const claimOf = (memo: string, buyer: string) => createHmac("sha256", secret).update(`${memo}|${buyer}`).digest("hex").slice(0, 32);
  const sameToken = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

  async function quote(assetIn: string, buyer: string): Promise<{ ok: true; quote: Quote } | { ok: false; status: number; error: string; message: string }> {
    const asset = assetIn.toUpperCase();
    if (!ASSET.test(asset)) return { ok: false, status: 400, error: "bad_asset", message: "asset: 2–10 letters, e.g. BTC" };
    if (!o.isAccount(buyer)) return { ok: false, status: 400, error: "bad_buyer", message: "buyer: the Concordium account that will pay into the escrow" };
    if (o.checkBuyer) {
      const c = await o.checkBuyer(buyer);
      if (!c.ok) return { ok: false, status: 403, error: c.reason, message: c.message };
    }
    const payBefore = now() + ttl;
    const memo = `vf1:${asset}:${Math.floor(payBefore / 1000).toString(36)}:${randomBytes(6).toString("hex")}`;
    return {
      ok: true,
      quote: {
        contract: o.contract,
        entrypoint: "pay",
        token_id: o.tokenId.toString(),
        amount_micro_ccd: o.priceMicroCcd.toString(),
        minutes,
        memo,
        claim_token: claimOf(memo, buyer),
        pay_before: new Date(payBefore).toISOString(),
        pay_to_recorded_by_contract: "the agentWallet CIS-8004 names for this token id when you pay; this server does not choose it",
        steps: [
          `pay: call ${o.contract} pay(token_id, minutes, memo) from ${buyer} with ${Number(o.priceMicroCcd) / 1e6} CCD attached, before pay_before`,
          "release: call release(escrow_id) from the same account; the contract reads the registry again and pays the recorded wallet",
          "deliver: POST /escrow-sale/<asset>/deliver with {escrow_id, claim_token}; keep claim_token private",
        ],
      },
    };
  }

  async function deliver(assetIn: string, idIn: string, claim: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const asset = assetIn.toUpperCase();
    const no = (status: number, error: string, message: string) => ({ status, body: { error, message } });
    if (!ASSET.test(asset)) return no(400, "bad_asset", "asset: 2–10 letters, e.g. BTC");
    if (!/^\d{1,19}$/.test(idIn)) return no(400, "bad_escrow_id", "escrow_id: the id the contract gave your payment");
    if (!/^[0-9a-f]{32}$/.test(claim)) return no(400, "bad_claim_token", "claim_token: from the quote");
    const id = BigInt(idIn);
    const e = await o.readEscrow(id);
    if (!e) return no(404, "no_such_escrow", `escrow ${id} does not exist in ${o.contract}`);
    const m = MEMO.exec(e.memo);
    // One answer for every mismatch of memo, buyer and token, so the endpoint does not tell anyone which part was wrong
    if (!m || m[1] !== asset || !sameToken(claimOf(e.memo, e.buyer), claim)) return no(403, "not_your_purchase", "This escrow was not paid with a quote for this asset and claim token.");
    const payBefore = parseInt(m[2], 36) * 1000;
    if (e.paidAt.getTime() > payBefore) return no(403, "quote_expired", "The escrow was paid after the quote expired. Refund it (it is still yours while held) or ask for a new quote.");
    if (now() > payBefore + window) return no(410, "delivery_window_over", `The window to collect this purchase (${window / 3600_000} h after the quote) has closed.`);
    if (e.tokenId !== o.tokenId.toString() || e.walletAtPay !== o.payTo || e.amountMicroCcd < o.priceMicroCcd) {
      return no(403, "wrong_payment", `The escrow must be for agent #${o.tokenId}, record ${o.payTo} as its wallet, and hold at least ${Number(o.priceMicroCcd) / 1e6} CCD.`);
    }
    if (e.state === "Held") return no(409, "not_released", `Escrow ${id} is still held. Release it (release(${id}) from the paying account): the contract checks the registry again and pays the seller; then ask again.`);
    if (e.state === "Refunded") return no(410, "refunded", `Escrow ${id} was refunded to the buyer.`);
    if (e.paidTo !== o.payTo) return no(403, "paid_elsewhere", `Escrow ${id} paid ${e.paidTo}, not the seller.`);

    const s = await o.serveSignal(asset);
    if (s.status !== 200) return s;
    return {
      status: 200,
      body: {
        ...s.body,
        payment: {
          via: "escrow",
          contract: o.contract,
          escrow_id: id.toString(),
          buyer: e.buyer,
          state: e.state,
          amount_micro_ccd: e.amountMicroCcd.toString(),
          agent: o.tokenId.toString(),
          wallet_at_pay: e.walletAtPay,
          paid_to: e.paidTo,
          checked: "read back from the escrow contract before delivery: paid for this agent with this quote's memo by the quoted buyer, the wallet the registry named at payment, and paid out to it after the contract read the registry again",
          contract_page: `${o.explorer}/contract/${o.contract.replace(/[<>]/g, "").replace(",", "/")}`,
        },
      },
    };
  }

  const router = express.Router();
  const perIpQuote = new RateLimiter(10, 10 * 60_000, now);
  const perIpDeliver = new RateLimiter(30, 10 * 60_000, now);
  const key = (req: express.Request) => (o.ipOf ?? ((q) => q.ip))(req);
  const limited = (lim: RateLimiter, req: express.Request, res: express.Response) => {
    const k = key(req);
    if (k === undefined || lim.take(k)) return false;
    res.status(429).json({ error: "rate_limited", retry_after_s: lim.retryAfterSec(k) });
    return true;
  };

  router.get("/escrow-sale/:asset/quote", async (req, res) => {
    if (limited(perIpQuote, req, res)) return;
    try {
      const q = await quote(String(req.params.asset), String(req.query.buyer ?? ""));
      if (!q.ok) return res.status(q.status).json({ error: q.error, message: q.message });
      res.json(q.quote);
    } catch (e) {
      log(`escrow sale quote failed: ${e instanceof Error ? e.message : e}`);
      res.status(502).json({ error: "quote_failed", message: "Could not check the buyer right now; nothing was reserved. Try again shortly." });
    }
  });

  router.post("/escrow-sale/:asset/deliver", async (req, res) => {
    if (!req.is("application/json")) return res.status(415).json({ error: "json_only" });
    if (limited(perIpDeliver, req, res)) return;
    try {
      const d = await deliver(String(req.params.asset), String(req.body?.escrow_id ?? ""), String(req.body?.claim_token ?? ""));
      res.status(d.status).json(d.body);
    } catch (e) {
      log(`escrow sale delivery failed: ${e instanceof Error ? e.message : e}`);
      res.status(502).json({ error: "delivery_failed", message: "The escrow could not be read right now. Your purchase is not lost: ask again with the same escrow_id and claim_token." });
    }
  });

  return { quote, deliver, router };
}
