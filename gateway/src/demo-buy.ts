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
import { RateLimiter } from "./security.js";
import { NET } from "./network.js";

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

export type DemoOptions = {
  makeAgent: () => Agent | Promise<Agent>;
  dailyLimit?: number;
  perIpPerHour?: number;
  now?: () => number;
  ipOf?: (req: express.Request) => string;
};

export function demoBuyRouter(o: DemoOptions) {
  const r = express.Router();
  const now = o.now ?? Date.now;
  const daily = o.dailyLimit ?? 20;
  const perIp = new RateLimiter(o.perIpPerHour ?? 3, 60 * 60_000, now);
  let busy = false;
  let day = "";
  let used = 0;
  let agent: Agent | undefined;
  const today = () => new Date(now()).toISOString().slice(0, 10);
  const left = () => (day === today() ? Math.max(0, daily - used) : daily);

  r.get("/demo/status", (_req, res) => res.json({ enabled: true, left_today: left(), daily_limit: daily, busy }));

  r.post("/demo/buy", async (req, res) => {
    const asset = String(req.body?.asset ?? "BTC").toUpperCase();
    if (asset !== "BTC" && asset !== "ETH") return res.status(400).json({ error: "asset must be BTC or ETH" });
    if (busy) return res.status(429).json({ error: "busy", message: "Another visitor's purchase is running. Try again in a few seconds." });
    if (left() <= 0) return res.status(429).json({ error: "daily_limit", message: `The demo buys at most ${daily} calls per UTC day. Try again tomorrow, or buy one yourself (TRY_IT.md, Path B).` });
    const key = (o.ipOf ?? ((q) => q.ip ?? "unknown"))(req);
    if (!perIp.take(key)) return res.status(429).json({ error: "per_ip_limit", message: `At most ${o.perIpPerHour ?? 3} demo purchases per hour per visitor.`, retry_after_s: perIp.retryAfterSec(key) });
    busy = true;
    if (day !== today()) { day = today(); used = 0; }
    used++;
    const started = now();
    try {
      agent ??= await o.makeAgent();
      const b = await agent.buySignal(asset);
      const body = (b.body && typeof b.body === "object" ? b.body : {}) as { canonical?: string; commitment?: string; anchor_tx?: string; buyer_agent?: { token_id: string; checked: string } };
      res.json({
        buyer: { account: agent.address, agent: agent.agentTokenId },
        seller_check: b.sellerCheck ? { ok: b.sellerCheck.ok, agent: b.sellerCheck.tokenId, payTo: b.sellerCheck.payTo, checks: b.sellerCheck.checks } : null,
        refused: b.refused,
        status: b.status,
        payment_tx: b.paymentExplorer ?? null,
        seller_checked_buyer: body.buyer_agent ?? null,
        canonical: body.canonical ?? null,
        commitment: body.commitment ?? null,
        anchor_tx: body.anchor_tx ?? null,
        commit_tx_url: body.anchor_tx ? `${NET.explorer}/transaction/${body.anchor_tx}` : null,
        error: b.status !== 200 && !b.refused ? (typeof b.body === "string" ? b.body.slice(0, 300) : JSON.stringify(b.body ?? null).slice(0, 300)) : null,
        ms: now() - started,
        left_today: left(),
      });
    } catch (e) {
      res.status(502).json({ error: "demo_failed", message: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300) });
    } finally {
      busy = false;
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
