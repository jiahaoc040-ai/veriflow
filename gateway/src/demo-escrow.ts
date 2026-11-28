/**
 * "Pay through the escrow contract": the live site's second demo button
 * --------------------------------------------------------------------
 * POST /demo/escrow runs, on the server, with our demo buyer #1478's testnet key:
 *   1. three read-only calls of the contract's pay for agents it must refuse (revoked, no wallet, not registered): nothing is sent
 *   2. pay: 1 testnet CCD into the escrow for agent #1313. The contract itself calls CIS-8004 agentOf and holds the CCD
 *      only because #1313 is Active and has an agentWallet, which it records
 *   3. release: the contract calls agentOf again and pays the wallet it recorded, only if the registry still names it
 * and returns both transactions and the escrow record read back from the contract. The visitor pays and signs nothing.
 *
 * Off unless DEMO_BUYER_KEY_FILE and ESCROW_CONTRACT are set. Limits: one demo at a time (shared with /demo/buy, same buyer
 * account and nonce), ESCROW_DEMO_PER_IP_PER_HOUR per visitor (default 2), ESCROW_DEMO_DAILY_LIMIT per UTC day (default 10).
 */
import express from "express";
import { randomBytes } from "node:crypto";
import { RateLimiter } from "./security.js";
import type { DailyCounter } from "./demo-buy.js";
import { memoryCounter } from "./demo-buy.js";

export type EscrowDemoRecord = { state: string; walletAtPay: string; paidTo: string | null; amountMicroCcd: bigint; tokenId: string; claimAfter: Date };

/** What the demo needs from the chain; gateway.ts builds it from gRPC (escrowChain below), tests pass a fake */
export type EscrowDemoChain = {
  contract: string;
  explorer: string;
  buyer: string;
  /** The module the contract instance runs, read from the node */
  moduleOf: () => Promise<string>;
  wouldAccept: (tokenId: bigint) => Promise<{ ok: boolean; code?: number; error?: string }>;
  pay: (tokenId: bigint, microCcd: bigint, minutes: number, memo: string) => Promise<{ ok: boolean; hex?: string; code?: number; error?: string }>;
  idOf: (memo: string) => Promise<bigint | null>;
  read: (id: bigint) => Promise<EscrowDemoRecord | null>;
  release: (id: bigint) => Promise<{ ok: boolean; hex?: string; code?: number; error?: string; transfers: { to: string; microCcd: bigint }[] }>;
};

export type EscrowDemoOptions = {
  makeChain: () => EscrowDemoChain | Promise<EscrowDemoChain>;
  expectedModule: string;
  lock: { busy: boolean };
  sellerAgent?: bigint;
  /** Agents the contract must refuse, shown as read-only calls: [token id, why] */
  refused?: [bigint, string][];
  microCcd?: bigint;
  counter?: DailyCounter;
  dailyLimit?: number;
  perIpPerHour?: number;
  now?: () => number;
  ipOf?: (req: express.Request) => string;
  log?: (m: string) => void;
  /** When set, the run is a real purchase: the memo comes from a quote for this buyer, and after release the signal is collected */
  sale?: {
    quote: (asset: string, buyer: string) => Promise<{ ok: true; quote: { memo: string; claim_token: string; minutes: number } } | { ok: false; status: number; error: string; message: string }>;
    deliver: (asset: string, id: string, claim: string) => Promise<{ status: number; body: Record<string, unknown> }>;
  };
  asset?: string;
};

export const DEFAULT_REFUSED: [bigint, string][] = [
  [11n, "a revoked agent"],
  [53n, "an agent with no agentWallet"],
  [99999999n, "a token id that is not registered"],
];

const sameAccount = (a: string, b: string) => a === b;

export function escrowDemoRouter(o: EscrowDemoOptions) {
  const r = express.Router();
  const now = o.now ?? Date.now;
  const daily = o.dailyLimit ?? 10;
  const ipLimit = o.perIpPerHour ?? 2;
  if (!Number.isInteger(daily) || daily < 0 || !Number.isInteger(ipLimit) || ipLimit < 0) throw new Error("escrow demo limits must be whole numbers ≥ 0");
  const perIp = new RateLimiter(ipLimit, 60 * 60_000, now);
  const counter = o.counter ?? memoryCounter();
  const log = o.log ?? ((m: string) => console.error(m));
  const seller = o.sellerAgent ?? 1313n;
  const amount = o.microCcd ?? 1_000_000n;
  const refused = o.refused ?? DEFAULT_REFUSED;
  const today = () => `escrow:${new Date(now()).toISOString().slice(0, 10)}`;
  const left = async () => Math.max(0, daily - (await counter.used(today()).catch(() => daily)));
  let chain: EscrowDemoChain | undefined;
  let lastRun: { at: string; body: Record<string, unknown> } | undefined;
  const replay = (reason: string) => (lastRun ? { ...lastRun.body, replay: { at: lastRun.at, reason } } : undefined);

  r.get("/demo/escrow/status", async (_req, res) => {
    try {
      chain ??= await o.makeChain();
      res.json({ enabled: true, contract: chain.contract, left_today: await left(), daily_limit: daily, busy: o.lock.busy });
    } catch {
      res.json({ enabled: false });
    }
  });

  r.post("/demo/escrow", async (req, res) => {
    if (!req.is("application/json") || req.get("sec-fetch-site") === "cross-site") return res.status(403).json({ error: "same_origin_json_only" });
    if (o.lock.busy) return res.status(429).json({ error: "busy", message: "Another visitor's demo is running. Try again in a few seconds." });
    const key = (o.ipOf ?? ((q) => q.ip ?? "unknown"))(req);
    if (!perIp.take(key)) { const rp = replay("per_ip_limit"); if (rp) return res.json(rp); return res.status(429).json({ error: "per_ip_limit", message: `At most ${ipLimit} escrow demos per hour per visitor.`, retry_after_s: perIp.retryAfterSec(key) }); }
    o.lock.busy = true;
    const started = now();
    try {
      let ok: boolean;
      try { ok = await counter.reserve(today(), daily); } catch (e) { log(`escrow demo: daily counter failed: ${e instanceof Error ? e.message : e}`); ok = false; }
      if (!ok) { const rp = replay("daily_limit"); if (rp) return res.json(rp); }
      if (!ok) return res.status(429).json({ error: "daily_limit", message: `The escrow demo runs at most ${daily} times per UTC day. Try again tomorrow, or run it yourself: npm run escrow -- pay 1313 1.` });
      chain ??= await o.makeChain();
      const c = chain;
      const link = (hex?: string) => (hex ? `${c.explorer}/transaction/${hex}` : null);

      // The contract must run the reviewed, verifiable module, or the demo shows nothing as proof
      const module = await c.moduleOf();
      if (module !== o.expectedModule) {
        log(`escrow demo: contract ${c.contract} runs module ${module}, expected ${o.expectedModule}`);
        return res.status(503).json({ error: "unexpected_module", message: "The escrow contract configured here is not the reviewed module. Nothing was sent." });
      }

      // 1. Read-only: the contract refuses these agents. No transaction, no fee
      const refusals = [];
      for (const [id, why] of refused) {
        const w = await c.wouldAccept(id);
        refusals.push({ agent: id.toString(), why, refused: !w.ok, code: w.code ?? null, error: w.error ?? null });
      }

      // 2. pay: the contract reads agentOf(#1313) and holds the CCD for its agentWallet.
      //    With a sale: the memo is a quote for this buyer and asset, so what is bought is a signal, collected after release
      const asset = o.asset ?? "BTC";
      let memo = `site demo ${randomBytes(6).toString("hex")}`;
      let claim: string | undefined;
      let minutes = 10;
      if (o.sale) {
        const q = await o.sale.quote(asset, c.buyer);
        if (!q.ok) return res.json({ ok: false, step: "quote", refusals, quote: { error: q.error, message: q.message }, ms: now() - started, left_today: await left() });
        memo = q.quote.memo;
        claim = q.quote.claim_token;
        minutes = q.quote.minutes;
      }
      const pay = await c.pay(seller, amount, minutes, memo);
      if (!pay.ok) {
        return res.json({ ok: false, step: "pay", refusals, pay: { tx: link(pay.hex), code: pay.code ?? null, error: pay.error ?? null }, ms: now() - started, left_today: await left() });
      }
      const id = await c.idOf(memo);
      const held = id !== null ? await c.read(id) : null;
      if (id === null || !held) {
        log(`escrow demo: paid (${pay.hex}) but could not read the escrow back`);
        return res.status(502).json({ error: "read_back_failed", message: "The payment went in, but the escrow could not be read back. It can be released later.", pay: { tx: link(pay.hex) } });
      }

      // 3. release: the contract reads agentOf(#1313) again and pays only the wallet recorded at payment
      const rel = await c.release(id);
      const after = await c.read(id).catch(() => null);
      const paidTo = rel.transfers[0]?.to ?? after?.paidTo ?? null;
      const out: Record<string, unknown> = {
        ok: rel.ok,
        contract: c.contract,
        module,
        buyer: c.buyer,
        seller_agent: seller.toString(),
        escrow_id: id.toString(),
        refusals,
        pay: { tx: link(pay.hex), held_micro_ccd: held.amountMicroCcd.toString(), wallet_at_pay: held.walletAtPay, state: held.state },
        release: { tx: link(rel.hex), code: rel.code ?? null, error: rel.error ?? null, transfers: rel.transfers.map((t) => ({ to: t.to, micro_ccd: t.microCcd.toString() })) },
        after: after ? { state: after.state, paid_to: after.paidTo } : null,
        paid_recorded_wallet: paidTo !== null && sameAccount(paidTo, held.walletAtPay),
        ms: now() - started,
        left_today: await left(),
      };
      // 4. With a sale: collect the signal. The server reads the escrow back and hands it over only now that the contract has paid
      if (o.sale && claim && rel.ok) {
        const d = await o.sale.deliver(asset, id.toString(), claim).catch((e) => ({ status: 502, body: { error: "delivery_failed", message: e instanceof Error ? e.message : String(e) } as Record<string, unknown> }));
        Object.assign(out, { asset, memo, delivered: d.status === 200, signal_purchase: d.status === 200 ? d.body : { status: d.status, ...d.body } });
      }
      if (rel.ok) lastRun = { at: new Date(now()).toISOString(), body: out };
      res.json(out);
    } catch (e) {
      log(`escrow demo failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      res.status(502).json({ error: "demo_failed", message: "The escrow demo failed. Nothing more is shown here; please try again later." });
    } finally {
      o.lock.busy = false;
    }
  });
  return r;
}

export function escrowDemoDisabledRouter() {
  const r = express.Router();
  r.get("/demo/escrow/status", (_req, res) => res.json({ enabled: false }));
  r.post("/demo/escrow", (_req, res) => res.status(503).json({ error: "demo_disabled", message: "The escrow demo is not configured on this server." }));
  return r;
}

/** The real chain: gRPC, the demo buyer's key, its nonce queued with every other use of that account in this process */
export async function escrowChain(keyFile: string, contractIndex: bigint): Promise<EscrowDemoChain> {
  const { ContractAddress, ModuleReference } = await import("@concordium/web-sdk");
  const { loadAccount } = await import("./config.js");
  const { createGrpc } = await import("./grpc.js");
  const { NET } = await import("./network.js");
  const { serialize, pickNonce, forgetNonce } = await import("./txqueue.js");
  const e = await import("./escrow.js");
  const grpc = createGrpc();
  const acct = loadAccount(keyFile);
  const contract = ContractAddress.create(contractIndex, 0n);
  const send = (entry: string, param: Buffer, micro: bigint) =>
    serialize(acct.address, () =>
      e.escrowSend(grpc, contract, acct, entry, param, micro, { nonce: (n) => pickNonce(acct.address, n) }).catch((err) => { forgetNonce(acct.address); throw err; }),
    );
  return {
    contract: `<${contractIndex},0>`,
    explorer: NET.explorer,
    buyer: acct.address,
    moduleOf: async () => ModuleReference.toHexString((await grpc.getInstanceInfo(contract)).sourceModule),
    wouldAccept: (id) => e.escrowWouldAccept(grpc, contract, acct.accountAddress, id),
    pay: (id, micro, minutes, memo) => send("pay", e.encodePay(id, minutes, memo), micro),
    idOf: (memo) => e.escrowIdOf(grpc, contract, acct.address, memo),
    read: (id) => e.escrowRead(grpc, contract, id),
    release: (id) => send("release", e.escrowU64(id), 0n),
  };
}
