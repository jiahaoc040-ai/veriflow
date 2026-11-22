/**
 * 每日訊號 v2（在 GitHub Actions 上跑，不在 Render）
 * ------------------------------------------------
 * Render 的 IP 連不到 Binance，所以 v2 的訊號在 GitHub 的機器上產生並上鏈：
 *   1. 公開到期的承諾：資料庫裡 v2 的訊號，滿 7 天、鏈上還沒公開的，用 canonical 送 reveal
 *   2. 昨天收盤（as_of）的訊號：鏈上這一格還空著才做。資料庫有同一天的 v2 訊號就沿用（不換 nonce），
 *      沒有才用 Binance 日 K 算 momentum、產生新的 canonical，先寫進資料庫再 commit，確認後記下交易
 * 上鏈帳號是低餘額、可撤銷的 committer（COMMITTER_KEY_FILE），不是擁有者 4dNM。
 * Render 上的付費 API 只賣資料庫裡「已上鏈」的 v2 訊號。
 *
 *   npm run daily2      （需要 REGISTRY_V2_CONTRACT、COMMITTER_KEY_FILE、DATABASE_URL）
 */
import { createHash } from "node:crypto";
import { env } from "./config.js";
import { createV2Writer, v2Address, HORIZON_MS, type SlotV2 } from "./contract-v2.js";
import { binanceDaily, canonicalV2, dayMs, dayOf, momentumE6, newNonce, ruleV2, SYMBOLS, type Candle } from "./signal-v2.js";

const DAY = 86_400_000;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export type Row = { commitment: string; asset: string; as_of: string; canonical: string; anchor_tx: string | null };
export type DailyV2Deps = {
  now: number;
  assets: string[];
  slot: (asset: string, asOf: string) => Promise<SlotV2 | null>;
  commit: (asset: string, asOf: string, commitment: string) => Promise<string>;
  reveal: (canonical: string) => Promise<string>;
  candles: (asset: string, sinceDay: string) => Promise<Candle[]>;
  db: {
    v2Rows: () => Promise<Row[]>;
    forDay: (asset: string, asOf: string) => Promise<Row[]>;
    insert: (r: { commitment: string; asset: string; as_of: string; signal: string; close: number; canonical: string; issued_at: string }) => Promise<void>;
    setAnchor: (commitment: string, tx: string) => Promise<void>;
  };
  nonce?: () => string;
  log?: (m: string) => void;
};

const isV2 = (canonical: string) => canonical.includes('"momentum_e6":');

export async function runDailyV2(d: DailyV2Deps) {
  const log = d.log ?? (() => {});
  const out: { reveals: string[]; commits: string[]; skipped: string[]; errors: string[] } = { reveals: [], commits: [], skipped: [], errors: [] };

  // 1. 到期公開
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

  // 2. 昨天收盤的訊號（合約只在 as_of 之後那一天接受）
  const asOf = dayOf(d.now - DAY);
  for (const asset of d.assets) {
    try {
      const onChain = await d.slot(asset, asOf);
      if (onChain) {
        out.skipped.push(`${asset} ${asOf} already committed`);
        const mine = (await d.db.forDay(asset, asOf)).find((r) => r.commitment === onChain.commitment);
        if (!mine) out.errors.push(`${asset} ${asOf}: on-chain commitment ${onChain.commitment.slice(0, 12)}… is not in the database`);
        continue;
      }
      let row = (await d.db.forDay(asset, asOf)).find((r) => isV2(r.canonical));
      if (!row) {
        const candles = await d.candles(asset, dayOf(dayMs(asOf) - 40 * DAY));
        const m = momentumE6(candles, asOf);
        if (m === null) throw new Error(`Binance candles for ${asOf} or 30 days earlier are missing`);
        const canonical = canonicalV2(asset, asOf, m, (d.nonce ?? newNonce)());
        const close = candles.find((k) => k.openTime === dayMs(asOf))!.close;
        row = { commitment: sha(canonical), asset, as_of: asOf, canonical, anchor_tx: null };
        await d.db.insert({ commitment: row.commitment, asset, as_of: asOf, signal: ruleV2(m), close, canonical, issued_at: new Date(d.now).toISOString() });
      }
      const tx = await d.commit(asset, asOf, row.commitment);
      await d.db.setAnchor(row.commitment, tx);
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
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 2, ssl: /sslmode=require|neon\.tech/.test(url) ? { rejectUnauthorized: true } : undefined });
  const w = createV2Writer(env("COMMITTER_KEY_FILE"), address);
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
          "INSERT INTO signals (commitment, asset, as_of, signal, close, canonical, issued_at, anchor_tx) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL) ON CONFLICT (commitment) DO NOTHING",
          [r.commitment, r.asset, r.as_of, r.signal, r.close, r.canonical, r.issued_at],
        );
      },
      setAnchor: async (c, tx) => void (await pool.query("UPDATE signals SET anchor_tx=$1 WHERE commitment=$2", [tx, c])),
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
