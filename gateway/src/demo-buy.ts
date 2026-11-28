/**
 * "Watch our buyer agent buy one call": the live site's demo button
 * ----------------------------------------------------------------
 * POST /demo/buy {"asset":"BTC"} runs our buyer agent #1478 on the server, exactly as `npm run buyer` does on a laptop:
 * it checks the seller on Concordium, pays 1 testnet CCD over x402 only if every check passes, and returns every step.
 * The visitor pays nothing and signs nothing; the page then re-checks the bought call against the chain in the browser.
 *
 * Off unless DEMO_BUYER_KEY_FILE is set (on Render: a Secret File). Limits: one purchase at a time, DEMO_PER_IP_PER_HOUR
 * per visitor (default 3) and DEMO_DAILY_LIMIT per UTC day for the whole site (default 20). The buyer's balance bounds the rest.
 */
import express from "express";
import { RateLimiter, scrubDetail } from "./security.js";
import { NET } from "./network.js";
import { pgSsl } from "./once.js";

type Agent = {
  address: string;
  agentTokenId?: string;
  buySignal: (asset: string) => Promise<{
    status: number;
    body: unknown;
    paymentExplorer?: string;
    sellerCheck?: { ok: boolean; checks: { name: string; ok: boolean; detail: string }[]; tokenId?: string; payTo: string };
    refused: boolean;
    needsVerification?: boolean;
    buyerAgentRefused?: boolean;
  }>;
};

/** The site-wide daily budget. In memory by default; Postgres when deployed, so a restart does not reset it */
export type DailyCounter = {
  /** Count one purchase for this UTC day if fewer than `limit` were counted; false = limit reached */
  reserve(day: string, limit: number): Promise<boolean>;
  used(day: string): Promise<number>;
};

export function memoryCounter(): DailyCounter {
  const m = new Map<string, number>();
  return {
    async reserve(day, limit) {
      const n = m.get(day) ?? 0;
      if (n >= limit) return false;
      m.clear();
      m.set(day, n + 1);
      return true;
    },
    async used(day) {
      return m.get(day) ?? 0;
    },
  };
}

export function postgresCounter(url: string): DailyCounter {
  let pool: import("pg").Pool | undefined;
  const db = async () => {
    if (!pool) {
      const { default: pg } = await import("pg");
      pool = new pg.Pool({ connectionString: url, max: 2, ssl: pgSsl(url) });
      await pool.query("CREATE TABLE IF NOT EXISTS demo_buys (day TEXT PRIMARY KEY, n INTEGER NOT NULL)");
    }
    return pool;
  };
  return {
    async reserve(day, limit) {
      // One atomic statement: insert the day's first purchase, or add one only while under the limit
      const { rows } = await (await db()).query(
        "INSERT INTO demo_buys (day, n) VALUES ($1, 1) ON CONFLICT (day) DO UPDATE SET n = demo_buys.n + 1 WHERE demo_buys.n < $2 RETURNING n",
        [day, limit],
      );
      return rows.length === 1 && limit > 0;
    },
    async used(day) {
      const { rows } = await (await db()).query("SELECT n FROM demo_buys WHERE day = $1", [day]);
      return rows[0]?.n ?? 0;
    },
  };
}

const validLimit = (n: number, what: string) => {
  if (!Number.isInteger(n) || n < 0) throw new Error(`${what} must be a whole number ≥ 0, got ${n}`);
  return n;
};

/** A short error code from the seller's JSON body, never the body itself */
export function safeErrorCode(body: unknown): string | null {
  const e = body && typeof body === "object" ? (body as { error?: unknown }).error : undefined;
  return typeof e === "string" && /^[a-z0-9_:.-]{1,60}$/i.test(e) ? e : null;
}

export type DemoOptions = {
  makeAgent: () => Agent | Promise<Agent>;
  counter?: DailyCounter;
  log?: (msg: string) => void;
  dailyLimit?: number;
  perIpPerHour?: number;
  now?: () => number;
  ipOf?: (req: express.Request) => string;
  /** Shared with the escrow demo: both send from the same buyer account */
  lock?: { busy: boolean };
  /** The on-chain record of the seller's re-check for a payment, once anchored (gateway.ts) */
  recheckOf?: (paymentTx: string) => { tx: string; data: string } | null;
};

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function demoBuyRouter(o: DemoOptions) {
  const r = express.Router();
  const now = o.now ?? Date.now;
  const daily = validLimit(o.dailyLimit ?? 20, "DEMO_DAILY_LIMIT");
  const ipLimit = validLimit(o.perIpPerHour ?? 3, "DEMO_PER_IP_PER_HOUR");
  const perIp = new RateLimiter(ipLimit, 60 * 60_000, now);
  const counter = o.counter ?? memoryCounter();
  const log = o.log ?? ((m: string) => console.error(m));
  const lock = o.lock ?? { busy: false };
  // The most recent successful run: shown (marked as a replay, with its time) when today's runs are used up, so a judge always sees
  // a complete purchase whose every link opens on-chain
  let lastRun: { at: string; body: Record<string, unknown> } | undefined;
  const replay = (reason: string) => (lastRun ? { ...lastRun.body, replay: { at: lastRun.at, reason } } : undefined);
  // The seller records each re-check on-chain right after settlement; wait briefly for it so the page can link it
  const recheckRecord = async (paymentUrl?: string | null) => {
    const tx = paymentUrl?.match(/[0-9a-f]{64}$/)?.[0];
    if (!tx || !o.recheckOf) return null;
    for (let i = 0; i < 20; i++) {
      const r = o.recheckOf(tx);
      if (r) return `${NET.explorer}/transaction/${r.tx}`;
      await sleepMs(500);
    }
    return null;
  };
  let agent: Agent | undefined;
  const today = () => new Date(now()).toISOString().slice(0, 10);
  const left = async () => Math.max(0, daily - (await counter.used(today()).catch(() => daily)));

  r.get("/demo/status", async (_req, res) => res.json({ enabled: true, left_today: await left(), daily_limit: daily, busy: lock.busy }));

  r.post("/demo/buy", async (req, res) => {
    // Only the page itself may press the button: a JSON body (a plain cross-site form cannot send one) and no cross-site fetch
    if (!req.is("application/json") || req.get("sec-fetch-site") === "cross-site") return res.status(403).json({ error: "same_origin_json_only" });
    const asset = String(req.body?.asset ?? "").toUpperCase();
    if (asset !== "BTC" && asset !== "ETH") return res.status(400).json({ error: "asset must be BTC or ETH" });
    if (lock.busy) return res.status(429).json({ error: "busy", message: "Another visitor's purchase is running. Try again in a few seconds." });
    const key = (o.ipOf ?? ((q) => q.ip ?? "unknown"))(req);
    if (!perIp.take(key)) { const rp = replay("per_ip_limit"); if (rp) return res.json(rp); return res.status(429).json({ error: "per_ip_limit", message: `At most ${ipLimit} demo purchases per hour per visitor.`, retry_after_s: perIp.retryAfterSec(key) }); }
    lock.busy = true;
    const started = now();
    try {
      let ok: boolean;
      try { ok = await counter.reserve(today(), daily); } catch (e) { log(`demo: daily counter failed: ${e instanceof Error ? e.message : e}`); ok = false; }
      if (!ok) { const rp = replay("daily_limit"); if (rp) return res.json(rp); }
      if (!ok) return res.status(429).json({ error: "daily_limit", message: `The demo buys at most ${daily} calls per UTC day. Try again tomorrow, or buy one yourself (TRY_IT.md, Path B).` });
      agent ??= await o.makeAgent();
      const b = await agent.buySignal(asset);
      const body = (b.body && typeof b.body === "object" ? b.body : {}) as { canonical?: string; commitment?: string; anchor_tx?: string; buyer_agent?: { token_id: string; checked: string }; buyer_eligibility?: Record<string, unknown> };
      const out = {
        buyer: { account: agent.address, agent: agent.agentTokenId },
        seller_check: b.sellerCheck ? { ok: b.sellerCheck.ok, agent: b.sellerCheck.tokenId, payTo: b.sellerCheck.payTo, checks: b.sellerCheck.checks.map((c) => ({ ...c, detail: scrubDetail(c.detail) })) } : null,
        refused: b.refused,
        status: b.status,
        payment_tx: b.paymentExplorer ?? null,
        seller_checked_buyer: body.buyer_agent ?? null,
        // The seller's re-check of our buyer's zero-knowledge proof for this payment: two on-chain anchors and the validity
        seller_checked_eligibility: body.buyer_eligibility ?? null,
        seller_recheck_record_tx: await recheckRecord(b.paymentExplorer),
        canonical: body.canonical ?? null,
        commitment: body.commitment ?? null,
        anchor_tx: body.anchor_tx ?? null,
        commit_tx_url: body.anchor_tx ? `${NET.explorer}/transaction/${body.anchor_tx}` : null,
        // Only a short error code from the seller, never its body
        error: b.status !== 200 && !b.refused ? safeErrorCode(b.body) ?? `http_${b.status}` : null,
        ms: now() - started,
        left_today: await left(),
      };
      if (b.status === 200 && out.payment_tx) lastRun = { at: new Date(now()).toISOString(), body: out };
      res.json(out);
    } catch (e) {
      // The real reason goes to the server log only (it can name files or hosts)
      log(`demo: purchase failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      res.status(502).json({ error: "demo_failed", message: "The demo purchase failed. Nothing more is shown here; please try again later." });
    } finally {
      lock.busy = false;
    }
  });
  return r;
}

/** Disabled: the button is hidden, and the API says why */
export function demoDisabledRouter() {
  const r = express.Router();
  r.get("/demo/status", (_req, res) => res.json({ enabled: false }));
  r.post("/demo/buy", (_req, res) => res.status(503).json({ error: "demo_disabled", message: "The demo buyer is not configured on this server." }));
  return r;
}
