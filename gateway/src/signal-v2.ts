/**
 * Signal v2: 30-day momentum from Binance spot daily candles only (data-api.binance.vision)
 * -----------------------------------------------------------------
 *   momentum(D)   = close(D) / close(D − 30 calendar days) − 1
 *   momentum_e6   = (close(D) − close(D−30)) × 1,000,000 / close(D−30), rounded to an integer with .5 away from zero
 *                   computed entirely in integers: closes are converted exactly from Binance's decimal strings to 1e-8 units (BigInt), never through floats
 *   signal        = RISK_ON if and only if momentum_e6 > 0
 * Anyone can recompute it from the same URL; on reveal the contract also checks that signal agrees with momentum_e6.
 * canonical has fixed fields, sorted alphabetically, no whitespace (contract v2's parse_canonical accepts only this format).
 */
import { randomBytes } from "node:crypto";

export const BINANCE_KLINES = "https://data-api.binance.vision/api/v3/klines";
export const SYMBOLS: Record<string, string> = { BTC: "BTCUSDT", ETH: "ETHUSDT" };
export const LOOKBACK_DAYS = 30;
const DAY = 86_400_000;

/** close: float (only for returns); closeUnits: exact integer close × 1e8 (used for the signal) */
export type Candle = { openTime: number; closeTime: number; close: number; closeUnits: bigint };

/** Binance decimal string (up to 8 decimals) → integer in 1e-8 units; throws on a bad format */
export function toUnits(s: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,8}))?$/.exec(s);
  if (!m) throw new Error(`price ${s} is not a plain decimal`);
  return BigInt(m[1]) * 100_000_000n + BigInt((m[2] ?? "").padEnd(8, "0"));
}

/** Integer division, .5 rounded away from zero */
export function divHalfAway(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new Error("divisor must be positive");
  const a = n < 0n ? -n : n;
  const q = (2n * a + d) / (2n * d);
  return n < 0n ? -q : q;
}

export const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** .5 rounded away from zero (Python's round is banker's rounding, so both sides use this) */
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

/** Closed daily candles (closeTime < now) */
export async function binanceDaily(asset: string, sinceDay: string, now = Date.now(), f: typeof fetch = fetch): Promise<Candle[]> {
  const url = `${BINANCE_KLINES}?symbol=${SYMBOLS[asset]}&interval=1d&startTime=${dayMs(sinceDay)}&limit=1000`;
  const r = await f(url);
  if (!r.ok) throw new Error(`Binance ${asset} HTTP ${r.status}`);
  const rows = (await r.json()) as unknown[][];
  return rows
    .map((k) => ({ openTime: Number(k[0]), closeTime: Number(k[6]), close: Number(k[4]), closeUnits: toUnits(String(k[4])) }))
    .filter((k) => k.closeTime < now);
}
