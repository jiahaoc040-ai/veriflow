/**
 * 訊號 v2：只用 Binance 現貨日 K（data-api.binance.vision）的 30 天動能
 * -----------------------------------------------------------------
 *   momentum(D)   = close(D) / close(D − 30 個日曆日) − 1
 *   momentum_e6   = 四捨五入（0.5 往遠離 0 的方向）到整數的 momentum × 1,000,000
 *   signal        = RISK_ON 當且僅當 momentum_e6 > 0
 * 任何人都能用同一個網址重算，合約在公開時也檢查 signal 與 momentum_e6 一致。
 * canonical 欄位固定、依字母排序、沒有空白（合約 v2 的 parse_canonical 只接受這個格式）。
 */
import { randomBytes } from "node:crypto";

export const BINANCE_KLINES = "https://data-api.binance.vision/api/v3/klines";
export const SYMBOLS: Record<string, string> = { BTC: "BTCUSDT", ETH: "ETHUSDT" };
export const LOOKBACK_DAYS = 30;
const DAY = 86_400_000;

export type Candle = { openTime: number; closeTime: number; close: number };

export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** 0.5 往遠離 0 的方向進位（Python 的 round 是銀行家進位，兩邊都用這個） */
export function roundHalfAway(x: number): number {
  return x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5);
}

export function momentumE6(candles: Candle[], asOf: string): number | null {
  const at = (d: number) => candles.find((k) => k.openTime === d)?.close;
  const now = at(dayMs(asOf));
  const then = at(dayMs(asOf) - LOOKBACK_DAYS * DAY);
  if (now === undefined || then === undefined || !(then > 0)) return null;
  return roundHalfAway((now / then - 1) * 1e6);
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
  return rows.map((k) => ({ openTime: Number(k[0]), closeTime: Number(k[6]), close: Number(k[4]) })).filter((k) => k.closeTime < now);
}
