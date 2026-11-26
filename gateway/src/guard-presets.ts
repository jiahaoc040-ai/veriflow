/**
 * "Check another team's seller" on the live site: the guard run by the server against a fixed list of x402 sellers, without paying.
 * Fixed list only: a visitor cannot make this server fetch an address of their choosing.
 * Results are cached for a minute, so the button cannot be used to flood those sellers or the public node.
 */
import express from "express";
import { checkSellerAt, summarize, type GuardDeps, type GuardVerdict } from "./guard.js";
import { scrubDetail } from "./security.js";

export type Preset = { id: string; name: string; who: string; url: string; init: RequestInit };

const QA = JSON.stringify({
  question: "Explain why the sky appears blue during the day.",
  answer: "Sunlight is scattered by air molecules, and short blue wavelengths scatter far more than red ones (Rayleigh scattering), so blue light reaches us from every direction.",
  marks: 10,
});

export function presets(publicUrl: string): Preset[] {
  return [
    { id: "mainsmarker", name: "MainsMarker (agent #990)", who: "another team: AI answer review", url: "https://mainsmarker.sites.tab.bot/x402/review", init: { method: "POST", body: QA, headers: { "content-type": "application/json" } } },
    { id: "vet402", name: "vet402 (agent #1268)", who: "another team: delivery records", url: "https://vet402-concordium.fly.dev/judge?badge=4iuMKkWLJSJo2LqKneemPoeNoSeUhTm8RckaXzfZ94De1Bi6Sc", init: { method: "GET" } },
    { id: "oraclescout", name: "Oracle Scout (agent #1253)", who: "another team: market data packs", url: "https://web-gilt-phi-11.vercel.app/api/packs/rehearsal-btc-150k", init: { method: "GET" } },
    { id: "cleartopay", name: "Clear to Pay", who: "another team: escrow pre-clearance (no Agent Card on its site)", url: "https://cleartopay-concordium.vercel.app/api/preclear?escrow=13161&order=2", init: { method: "GET" } },
    { id: "vet402-s2", name: "vet402 S2", who: "the vet402 team's test seller, on vet402's site", url: "https://vet402-concordium.fly.dev/s2/resource", init: { method: "GET" } },
    { id: "vet402-s3", name: "vet402 S3", who: "the vet402 team's seller built to take payment and return nothing", url: "https://vet402-concordium.fly.dev/s3/resource", init: { method: "GET" } },
    { id: "veriflow", name: "VeriFlow (agent #1313)", who: "this site's own seller", url: `${publicUrl}/signal/BTC`, init: { method: "GET" } },
  ];
}

export function guardPresetRouter(o: { publicUrl: string; deps: () => GuardDeps; now?: () => number; ttlMs?: number; log?: (m: string) => void }) {
  const r = express.Router();
  const list = presets(o.publicUrl);
  const now = o.now ?? Date.now;
  const ttl = o.ttlMs ?? 60_000;
  const cache = new Map<string, { at: number; body: unknown }>();
  const inflight = new Map<string, Promise<unknown>>();

  r.get("/guard/presets", (_req, res) => res.json(list.map(({ id, name, who, url }) => ({ id, name, who, url }))));

  r.get("/guard/check/:id", async (req, res) => {
    const p = list.find((x) => x.id === req.params.id);
    if (!p) return res.status(404).json({ error: "unknown_seller" });
    const hit = cache.get(p.id);
    if (hit && now() - hit.at < ttl) return res.json(hit.body);
    let job = inflight.get(p.id);
    if (!job) {
      job = (async () => {
        try {
          const { verdict, picked } = await checkSellerAt(p.url, p.init, o.deps());
          const body = shape(p, verdict, picked, now());
          cache.set(p.id, { at: now(), body });
          return body;
        } catch (e) {
          (o.log ?? console.error)(`guard preset ${p.id}: ${e instanceof Error ? e.message : e}`);
          const body = { id: p.id, name: p.name, error: "check_failed", message: "Could not reach that seller or a Concordium node just now. Nothing was paid; try again in a minute." };
          // Failures are cached too (shorter), so a seller that is down is not asked again on every click
          cache.set(p.id, { at: now() - ttl + Math.min(ttl, 30_000), body });
          return body;
        } finally {
          inflight.delete(p.id);
        }
      })();
      inflight.set(p.id, job);
    }
    res.json(await job);
  });
  return r;
}

function shape(p: Preset, v: GuardVerdict, picked: { amount?: string; asset?: string; network: string; payTo: string }, at: number) {
  return {
    id: p.id, name: p.name, who: p.who, url: p.url, checked_at: new Date(at).toISOString(),
    asks: { amount: picked.amount, asset: picked.asset, network: picked.network, payTo: picked.payTo },
    agent: v.tokenId ?? null, ok: v.ok, summary: scrubDetail(summarize(v)), checks: v.checks.map((c) => ({ ...c, detail: scrubDetail(c.detail) })), paid: false,
  };
}
