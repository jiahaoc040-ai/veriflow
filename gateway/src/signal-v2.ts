/**
 * 訊號 v2：只用 Binance 現貨日 K（data-api.binance.vision）的 30 天動能
 * -----------------------------------------------------------------
 *   momentum(D)   = close(D) / close(D − 30 個日曆日) − 1
 *   momentum_e6   = (close(D) − close(D−30)) × 1,000,000 / close(D−30)，0.5 往遠離 0 的方向進位到整數
 *                   全程用整數算：收盤價以 Binance 回傳的十進位字串精確轉成 1e-8 單位（BigInt），不經過浮點數
 *   signal        = RISK_ON 當且僅當 momentum_e6 > 0
 * 任何人都能用同一個網址重算，合約在公開時也檢查 signal 與 momentum_e6 一致。
 * canonical 欄位固定、依字母排序、沒有空白（合約 v2 的 parse_canonical 只接受這個格式）。
 */
import { randomBytes } from "node:crypto";

export const BINANCE_KLINES = "https://data-api.binance.vision/api/v3/klines";
export const SYMBOLS: Record<string, string> = { BTC: "BTCUSDT", ETH: "ETHUSDT" };
export const LOOKBACK_DAYS = 30;
const DAY = 86_400_000;

/** close：浮點數（只用來算報酬）；closeUnits：收盤價 × 1e8 的精確整數（用來算訊號） */
export type Candle = { openTime: number; closeTime: number; close: number; closeUnits: bigint };

/** Binance 的十進位字串（最多 8 位小數）→ 1e-8 單位的整數；格式不對就丟錯 */
export function toUnits(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(s);
  if (!m) throw new Error(`price ${s} is not a plain decimal`);
  return BigInt(m[1]) * 100_000_000n + BigInt((m[2] ?? "").padEnd(8, "0"));
}

/** 整數除法，0.5 往遠離 0 的方向進位 */
export function divHalfAway(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error("divisor must be positive");
  const a = n < 0n ? -n : n;
  const q = (2n * a + d) / (2n * d);
  return n < 0n ? -q : q;
}

export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** 0.5 往遠離 0 的方向進位（Python 的 round 是銀行家進位，兩邊都用這個） */
export function roundHalfAway(x: number): number {
  return x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5);
}

export function momentumE6(candles: Candle[], asOf: string): number | null {
  const at = (d: number) => candles.find((k) => k.openTime === d)?.closeUnits;
  const now = at(dayMs(asOf));
  const then = at(dayMs(asOf) - LOOKBACK_DAYS * DAY);
  if (now === undefined || then === undefined || then <= 0n) return null;
  const m = divHalfAway((now - then) * 1_000_000n, then);
  if (m > BigInt(Number.MAX_SAFE_INTEGER) || m < -BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(m);
}

export const ruleV2 = (m: number) => (m > 0 ? "RISK_ON" : "RISK_OFF");

export function canonicalV2(asset: string, asOf: string, m: number, nonce: string): string {
  if (!SYMBOLS[asset]) throw new Error(`asset ${asset}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new Error(`as_of ${asOf}`);
  if (!Number.isSafeInteger(m)) throw new Error(`momentum_e6 ${m}`);
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error("nonce");
  return `{"as_of":"${asOf}","asset":"${asset}","momentum_e6":${m},"nonce":"${nonce}","signal":"${ruleV2(m)}"}`;
}

export const newNonce = () => randomBytes(16).toString("hex");

/** 已收盤的日 K（closeTime < now） */
export async function binanceDaily(asset: string, sinceDay: string, now = Date.now(), f: typeof fetch = fetch): Promise<Candle[]> {
  const url = `${BINANCE_KLINES}?symbol=${SYMBOLS[asset]}&interval=1d&startTime=${dayMs(sinceDay)}&limit=1000`;
  const r = await f(url);
  if (!r.ok) throw new Error(`Binance ${asset} HTTP ${r.status}`);
  const rows = (await r.json()) as unknown[][];
  return rows
    .map((k) => ({ openTime: Number(k[0]), closeTime: Number(k[6]), close: Number(k[4]), closeUnits: toUnits(String(k[4])) }))
    .filter((k) => k.closeTime < now);
}
