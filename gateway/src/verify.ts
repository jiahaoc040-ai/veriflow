/**
 * 驗證一個訊號承諾（與 Python 版 veriflow/verify.py 相同邏輯）
 *   1. 鏈上交易已確認
 *   2. 鏈上資料 == "veriflow:v1:" + 承諾雜湊
 *   3. （有訊號內容時）sha256(內容) == 承諾雜湊
 *   4. （有訊號內容與區塊時間時）上鏈時間在資料收盤後一天內——遠早於 7 天後的結果，
 *      不能等結果出來才補寫
 */
import { createHash } from "node:crypto";
import { ANCHOR_PREFIX } from "./anchor-format.js";

export type Check = { name: string; ok: boolean; detail: string };
type OnChain =
  | { status?: string; sender?: string | null; data_text?: string | null; block_time?: string | null; contract?: string; asset?: string; as_of?: string }
  | null
  | undefined;

const DAY_MS = 86_400_000;

/** 訊號內容裡的資料日期（as_of，YYYY-MM-DD）；內容不是 JSON 就回傳 undefined */
export function asOfOf(canonical: string): string | undefined {
  try {
    const v = (JSON.parse(canonical) as { as_of?: unknown }).as_of;
    return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 上鏈時間檢查：as_of 那根日 K 在隔天 00:00 UTC 收盤，訊號必須在收盤後一天內上鏈。
 * 晚上鏈的紀錄（例如等結果出來才補寫）就不算數。
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
    // 合約 v2：鏈上的鍵 (asset, as_of) 必須就是這個訊號的；同一天只能有這一筆，合約已經保證
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
