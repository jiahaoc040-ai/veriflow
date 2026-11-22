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
    /** 成功確認後寫入（覆蓋） */
    setAnchor: (commitment: string, tx: string) => Promise<void>;
    /** 送出當下：只有還沒記錄任何交易時才寫（另一個同時跑的排程先送出的那筆優先） */
    setAnchorIfNull: (commitment: string, tx: string) => Promise<void>;
    /** 鏈上拒絕：只有記錄的正好是這筆被拒絕的交易時才清掉 */
    clearAnchorIf: (commitment: string, tx: string) => Promise<void>;
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
        // 資料庫對 (asset, as_of) 的 v2 訊號有唯一索引：同時跑兩個排程時只有一筆寫得進去，用寫進去的那筆
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
          // 被拒絕的是這一次送出的交易；如果記錄的是別次（例如前一輪還在等確認、後來成功的那筆），不動它
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
  // 只接受檔案路徑：如果有人把金鑰 JSON 直接放進這個變數，讀檔錯誤訊息會把它印進 log
  if (keyFile.trim().startsWith("{") || keyFile.length > 512) throw new Error("COMMITTER_KEY_FILE must be a path to the key file, not its contents");
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: url, max: 2, ssl: /sslmode=require|neon\.tech/.test(url) ? { rejectUnauthorized: true } : undefined });
  let w: ReturnType<typeof createV2Writer>;
  try {
    w = createV2Writer(keyFile, address);
  } catch (e) {
    // 只印形狀，不印內容：大小、是不是 JSON、最上層欄位名稱、錯誤種類
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
