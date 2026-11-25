/**
 * Daily signals v2 (run on GitHub Actions, not on Render)
 * ------------------------------------------------
 * Render's IPs cannot reach Binance, so v2 signals are computed and committed on GitHub's machines:
 *   1. Reveal what is due: v2 signals in the database that are 7+ days old and not yet revealed on-chain are revealed with their canonical text
 *   2. Yesterday's close (as_of): only if that slot is still empty on-chain. If the database already has a v2 signal for the day, reuse it (same nonce);
 *      otherwise compute momentum from Binance daily candles, create a new canonical, write it to the database, then commit, and record the transaction once confirmed
 * The committing account is the low-balance, revocable committer (COMMITTER_KEY_FILE), not the owner 4dNM.
 * The paid API on Render sells only v2 signals from the database that are already on-chain.
 *
 *   npm run daily2      (needs REGISTRY_V2_CONTRACT, COMMITTER_KEY_FILE, DATABASE_URL)
 */
import { createHash } from "node:crypto";
import { env } from "./config.js";
import { createV2Writer, RejectedError, v2Address, HORIZON_MS, type SlotV2 } from "./contract-v2.js";
import { binanceDaily, canonicalV2, dayMs, dayOf, momentumE6, newNonce, ruleV2, SYMBOLS, type Candle } from "./signal-v2.js";

const DAY = 86_400_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export type Row = { commitment: string; asset: string; as_of: string; canonical: string; anchor_tx: string | null };
export type DailyV2Deps = {
  now: number;
  assets: string[];
  slot: (asset: string, asOf: string) => Promise<SlotV2 | null>;
  commit: (asset: string, asOf: string, commitment: string, onSent?: (tx: string) => Promise<void>) => Promise<string>;
  reveal: (canonical: string) => Promise<string>;
  candles: (asset: string, sinceDay: string) => Promise<Candle[]>;
  db: {
    v2Rows: () => Promise<Row[]>;
    forDay: (asset: string, asOf: string) => Promise<Row[]>;
    insert: (r: { commitment: string; asset: string; as_of: string; signal: string; close: number; canonical: string; issued_at: string }) => Promise<void>;
    /** Written after confirmation (overwrites) */
    setAnchor: (commitment: string, tx: string) => Promise<void>;
    /** At send time: written only if no transaction is recorded yet (a concurrently running job's earlier send wins) */
    setAnchorIfNull: (commitment: string, tx: string) => Promise<void>;
    /** Rejected on-chain: cleared only if the recorded transaction is exactly the rejected one */
    clearAnchorIf: (commitment: string, tx: string) => Promise<void>;
  };
  nonce?: () => string;
  log?: (m: string) => void;
};

const isV2 = (canonical: string) => canonical.includes('"momentum_e6":');

export async function runDailyV2(d: DailyV2Deps) {
  const log = d.log ?? (() => {});
  const out: { reveals: string[]; commits: string[]; skipped: string[]; errors: string[] } = { reveals: [], commits: [], skipped: [], errors: [] };

  // 1. Reveal what is due
  for (const r of await d.db.v2Rows()) {
    if (!r.anchor_tx) continue;
    try {
      const s = await d.slot(r.asset, r.as_of);
      if (!s || s.commitment !== r.commitment || s.reveal) continue;
      if (d.now < Date.parse(s.committed_at) + HORIZON_MS + 60_000) continue;
      const tx = await d.reveal(r.canonical);
      out.reveals.push(`${r.asset} ${r.as_of} ${tx}`);
      log(`revealed ${r.asset} ${r.as_of} → ${tx}`);
    } catch (e) {
      out.errors.push(`reveal ${r.asset} ${r.as_of}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 2. Yesterday's close (the contract accepts it only on the day after as_of)
  const asOf = dayOf(d.now - DAY);
  for (const asset of d.assets) {
    try {
      const onChain = await d.slot(asset, asOf);
      if (onChain) {
        out.skipped.push(`${asset} ${asOf} already committed`);
        const mine = (await d.db.forDay(asset, asOf)).find((r) => r.commitment === onChain.commitment);
        if (!mine) out.errors.push(`${asset} ${asOf}: on-chain commitment ${onChain.commitment.slice(0, 12)}… is not in the database`);
        else if (!mine.anchor_tx) out.errors.push(`${asset} ${asOf}: committed on-chain but the transaction hash was not recorded`);
        continue;
      }
      let row = (await d.db.forDay(asset, asOf)).find((r) => isV2(r.canonical));
      if (!row) {
        const candles = await d.candles(asset, dayOf(dayMs(asOf) - 40 * DAY));
        const m = momentumE6(candles, asOf);
        if (m === null) throw new Error(`Binance candles for ${asOf} or 30 days earlier are missing`);
        const canonical = canonicalV2(asset, asOf, m, (d.nonce ?? newNonce)());
        const close = candles.find((k) => k.openTime === dayMs(asOf))!.close;
        await d.db.insert({ commitment: sha(canonical), asset, as_of: asOf, signal: ruleV2(m), close, canonical, issued_at: new Date(d.now).toISOString() });
        // The database has a unique index on (asset, as_of) for v2: if two jobs run at once only one row is written; use that one
        row = (await d.db.forDay(asset, asOf)).find((r) => isV2(r.canonical));
        if (!row) throw new Error("row was not stored");
      }
      const c = row.commitment;
      let tx: string;
      {
        let sentTx: string | null = null;
        try {
          tx = await d.commit(asset, asOf, c, async (sent) => {
            sentTx = sent;
            await d.db.setAnchorIfNull(c, sent);
          });
        } catch (e) {
          // The rejected transaction is the one sent now; if a different one is recorded (e.g. an earlier round's that later succeeded), leave it
          if (e instanceof RejectedError && sentTx) await d.db.clearAnchorIf(c, sentTx);
          throw e;
        }
      }
      await d.db.setAnchor(c, tx);
      out.commits.push(`${asset} ${asOf} ${tx}`);
      log(`committed ${asset} ${asOf} → ${tx}`);
    } catch (e) {
      out.errors.push(`commit ${asset} ${asOf}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return out;
}

async function main() {
  const address = v2Address();
  if (!address) throw new Error("REGISTRY_V2_CONTRACT is not set");
  const url = env("DATABASE_URL");
  const keyFile = env("COMMITTER_KEY_FILE");
  // Accept only a file path: if someone puts the key JSON itself in this variable, a read error would print it into the log
  if (keyFile.trim().startsWith("{") || keyFile.length > 512) throw new Error("COMMITTER_KEY_FILE must be a path to the key file, not its contents");
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 2, ssl: /sslmode=require|neon\.tech/.test(url) ? { rejectUnauthorized: true } : undefined });
  let w: ReturnType<typeof createV2Writer>;
  try {
    w = createV2Writer(keyFile, address);
  } catch (e) {
    // Print only the shape, never the content: size, whether it is JSON, top-level field names, error kind
    const { readFileSync, existsSync } = await import("node:fs");
    let shape = "file missing";
    if (existsSync(keyFile)) {
      const raw = readFileSync(keyFile, "utf8");
      let keys = "not JSON";
      try {
        const j = JSON.parse(raw);
        keys = `JSON keys [${Object.keys(j).join(", ")}]${j.value ? `, value keys [${Object.keys(j.value).join(", ")}]` : ""}, environment ${typeof j.environment === "string" ? j.environment : "?"}`;
      } catch {}
      shape = `${raw.length} bytes, ${keys}`;
    }
    throw new Error(`could not load the committer key file (${shape}; ${e instanceof Error ? e.constructor.name : typeof e})`);
  }
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS signals_v2_one_per_day ON signals (asset, as_of) WHERE canonical LIKE '%"momentum_e6":%'`);
  const cols = "commitment, asset, as_of, canonical, anchor_tx";
  const out = await runDailyV2({
    now: Date.now(),
    assets: Object.keys(SYMBOLS),
    slot: w.slot,
    commit: w.commit,
    reveal: w.reveal,
    candles: (asset, since) => binanceDaily(asset, since),
    db: {
      v2Rows: async () => (await pool.query(`SELECT ${cols} FROM signals WHERE canonical LIKE '%"momentum_e6":%' ORDER BY as_of`)).rows,
      forDay: async (asset, asOf) => (await pool.query(`SELECT ${cols} FROM signals WHERE asset=$1 AND as_of=$2 ORDER BY issued_at`, [asset, asOf])).rows,
      insert: async (r) => {
        await pool.query(
          "INSERT INTO signals (commitment, asset, as_of, signal, close, canonical, issued_at, anchor_tx) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL) ON CONFLICT DO NOTHING",
          [r.commitment, r.asset, r.as_of, r.signal, r.close, r.canonical, r.issued_at],
        );
      },
      setAnchor: async (c, tx) => void (await pool.query("UPDATE signals SET anchor_tx=$1 WHERE commitment=$2", [tx, c])),
      setAnchorIfNull: async (c, tx) => void (await pool.query("UPDATE signals SET anchor_tx=$1 WHERE commitment=$2 AND anchor_tx IS NULL", [tx, c])),
      clearAnchorIf: async (c, tx) => void (await pool.query("UPDATE signals SET anchor_tx=NULL WHERE commitment=$1 AND anchor_tx=$2", [c, tx])),
    },
    log: (m) => console.log(m),
  });
  await pool.end();
  console.log(JSON.stringify({ committer: w.address, contract: `<${address.index},${address.subindex}>`, ...out }, null, 2));
  if (out.errors.length) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0), (e) => {
    console.error("❌", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
