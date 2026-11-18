/**
 * 驗證一個訊號承諾（與 Python 版 veriflow/verify.py 相同邏輯）
 *   1. 鏈上交易已確認
 *   2. 鏈上資料 == "veriflow:v1:" + 承諾雜湊
 *   3. （有訊號內容時）sha256(內容) == 承諾雜湊
 */
import { createHash } from "node:crypto";
import { ANCHOR_PREFIX } from "./anchor-format.js";

export type Check = { name: string; ok: boolean; detail: string };
type OnChain = { status?: string; sender?: string; data_text?: string } | null | undefined;

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
  }
  return checks;
}

export const allOk = (checks: Check[]) => checks.length > 0 && checks.every((c) => c.ok);
