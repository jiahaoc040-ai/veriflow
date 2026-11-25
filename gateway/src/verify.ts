/**
 * Verify a signal commitment (same logic as the Python veriflow/verify.py)
 *   1. the on-chain transaction is confirmed
 *   2. on-chain data == "veriflow:v1:" + commitment hash
 *   3. (with the signal content) sha256(content) == commitment hash
 *   4. (with content and block time) anchored within a day of the data's close — long before the 7-day outcome,
 *      so it cannot be backfilled
 */
import { createHash } from "node:crypto";
import { ANCHOR_PREFIX } from "./anchor-format.js";

export type Check = { name: string; ok: boolean; detail: string };
type OnChain =
  | { status?: string; sender?: string | null; data_text?: string | null; block_time?: string | null; contract?: string; asset?: string; as_of?: string }
  | null
  | undefined;

const DAY_MS = 86_400_000;

/** The data date in the signal content (as_of, YYYY-MM-DD); undefined if the content is not JSON */
export function asOfOf(canonical: string): string | undefined {
  try {
    const v = (JSON.parse(canonical) as { as_of?: unknown }).as_of;
    return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Anchor time check: the as_of candle closes at 00:00 UTC the next day, and the signal must be anchored within a day of that close.
 * Records anchored later (e.g. backfilled after the outcome) do not count.
 */
export function anchoredInTime(asOf: string, blockTime: string): Check {
  const closed = Date.parse(`${asOf}T00:00:00Z`) + DAY_MS;
  const deadline = closed + DAY_MS;
  const t = Date.parse(blockTime);
  return {
    name: "anchored after the data close and within a day of it (long before the 7-day outcome)",
    ok: Number.isFinite(t) && t >= closed && t < deadline,
    detail: `anchored ${blockTime}; data ${asOf} closed ${new Date(Date.parse(`${asOf}T00:00:00Z`) + DAY_MS).toISOString()}`,
  };
}

export const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export function verifyCommitment(commitment: string, onchain: OnChain, canonical?: string): Check[] {
  const checks: Check[] = [];
  const status = onchain?.status;
  checks.push({
    name: "on-chain transaction confirmed",
    ok: status === "finalized" || status === "committed",
    detail: `status: ${status ?? "not found"}${onchain?.sender ? `, sender ${onchain.sender}` : ""}`,
  });
  const expected = ANCHOR_PREFIX + commitment;
  checks.push({
    name: "on-chain data matches commitment",
    ok: onchain?.data_text === expected,
    detail: `on-chain: ${onchain?.data_text ?? "no data"}`,
  });
  if (canonical !== undefined) {
    const h = sha256Hex(canonical);
    checks.push({ name: "signal content hashes to commitment", ok: h === commitment, detail: `sha256: ${h}` });
    const asOf = asOfOf(canonical);
    if (asOf) checks.push(anchoredInTime(asOf, onchain?.block_time ?? "(unknown)"));
    // Contract v2: the on-chain key (asset, as_of) must be this signal's; the contract already guarantees only one per day
    if (onchain?.contract) {
      let s: { asset?: unknown; as_of?: unknown } = {};
      try {
        s = JSON.parse(canonical);
      } catch {}
      const expected = `<${process.env.REGISTRY_V2_CONTRACT ?? "13115"},0>`;
      checks.push({
        name: `committed under this signal's own day on contract ${onchain.contract} (one call per asset and day)`,
        ok: onchain.contract === expected && s.asset === onchain.asset && s.as_of === onchain.as_of,
        detail: `on-chain key ${onchain.asset} ${onchain.as_of}; signal ${String(s.asset)} ${String(s.as_of)}`,
      });
    }
  }
  return checks;
}

export const allOk = (checks: Check[]) => checks.length > 0 && checks.every((c) => c.ok);
