/**
 * Daily public signals (v1, retired; v2 calls come from daily-v2.ts)
 * ------------
 * A record nobody can fake needs an entry every day, not only when someone pays.
 * This job periodically (every 30 minutes by default) calls the API's /daily/{asset} for each asset:
 *   - the API decides the latest close and issues a new signal only if that day has none on-chain yet
 *   - the commitment hash is anchored (contract commit or register data), then the transaction is reported back to the API
 *   - if anchoring fails it is retried next round; a day is never anchored twice
 * The content is the same as a paid signal, revealed and scored after 7 days.
 */

export type DailyDeps = {
  apiUrl: string;
  secret: string;
  assets: string[];
  anchor: (commitment: string, asset: string) => Promise<string>;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
};

export type DailyResult = { asset: string; status: string; as_of?: string; tx?: string; error?: string };

export async function runDailyOnce(d: DailyDeps): Promise<DailyResult[]> {
  const f = d.fetch ?? fetch;
  const headers = { "X-VeriFlow-Gateway": d.secret, "Content-Type": "application/json" };
  const out: DailyResult[] = [];
  for (const asset of d.assets) {
    try {
      const r = await f(`${d.apiUrl}/daily/${asset}`, { method: "POST", headers });
      if (!r.ok) throw new Error(`/daily/${asset} → HTTP ${r.status}`);
      const body = (await r.json()) as { status: string; as_of?: string; commitment?: string };
      if (body.status === "exists" || !body.commitment) {
        out.push({ asset, status: body.status, as_of: body.as_of });
        continue;
      }
      const tx = await d.anchor(body.commitment, asset);
      const a = await f(`${d.apiUrl}/commitments/${body.commitment}/anchor`, {
        method: "POST",
        headers,
        body: JSON.stringify({ anchor_tx: tx }),
      });
      if (!a.ok) throw new Error(`anchor report → HTTP ${a.status}`);
      out.push({ asset, status: "anchored", as_of: body.as_of, tx });
      d.log?.(`daily signal ${asset} ${body.as_of} anchored → ${tx}`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      out.push({ asset, status: "error", error });
      d.log?.(`daily signal ${asset} failed (will retry next round): ${error}`);
    }
  }
  return out;
}

/** Start the job: first run after firstDelayMs (so the API can fetch prices first), then every intervalMs; never two rounds at once */
export function startDailySignals(d: DailyDeps, intervalMs: number, firstDelayMs = 60_000, reveals?: RevealDeps) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDailyOnce(d);
      if (reveals) await runRevealsOnce(reveals).catch((e) => d.log?.(`reveal round failed: ${e instanceof Error ? e.message : String(e)}`));
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, firstDelayMs);
  const every = setInterval(tick, intervalMs);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

/**
 * Automatic reveal after the horizon
 * --------------------
 * Contract rule: once horizon (7 days) has passed since the commit, anyone can reveal; the contract accepts only if its own SHA-256 matches.
 * Here the server does it itself: each round, find commitments that are in the contract, past the horizon and not yet revealed, and send their content.
 * Commitments not in the contract (early register-data ones) are skipped; at most max per round, to limit fees.
 */
export type RevealDeps = {
  apiUrl: string;
  /** null = this commitment is not in the contract */
  record: (commitment: string) => Promise<{ committed_at: string; reveal: unknown | null } | null>;
  reveal: (canonical: string) => Promise<string>;
  horizonMs?: number;
  max?: number;
  now?: () => number;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
};

export type RevealResult = { commitment: string; status: "revealed" | "error"; tx?: string; error?: string };

export async function runRevealsOnce(d: RevealDeps): Promise<RevealResult[]> {
  const f = d.fetch ?? fetch;
  const now = (d.now ?? Date.now)();
  const horizon = d.horizonMs ?? 7 * 86_400_000;
  const max = d.max ?? 5;
  const r = await f(`${d.apiUrl}/commitments`);
  if (!r.ok) throw new Error(`/commitments → HTTP ${r.status}`);
  const rows = (await r.json()) as { commitment: string; anchor_tx?: string | null }[];
  const out: RevealResult[] = [];
  for (const row of rows) {
    if (out.length >= max) break;
    if (!row.anchor_tx) continue;
    let rec: { committed_at: string; reveal: unknown | null } | null;
    try {
      rec = await d.record(row.commitment);
    } catch {
      continue; // lookup failed this round (node briefly unreachable); try again next round
    }
    if (!rec || rec.reveal) continue; // not in the contract (register-data era) or already revealed
    if (now < Date.parse(rec.committed_at) + horizon + 60_000) continue; // wait an extra minute for block-time skew
    try {
      const c = await f(`${d.apiUrl}/commitments/${row.commitment}`);
      const canonical = c.ok ? ((await c.json()) as { canonical?: string }).canonical : undefined;
      if (!canonical) continue; // the API has not made the content public yet
      const tx = await d.reveal(canonical);
      out.push({ commitment: row.commitment, status: "revealed", tx });
      d.log?.(`revealed ${row.commitment.slice(0, 12)}… on-chain → ${tx}`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      out.push({ commitment: row.commitment, status: "error", error });
      d.log?.(`reveal ${row.commitment.slice(0, 12)}… failed (will retry next round): ${error}`);
    }
  }
  return out;
}
