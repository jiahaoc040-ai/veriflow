import { test } from "node:test";
import assert from "node:assert/strict";
import { allOk, sha256Hex, verifyCommitment } from "../src/verify.ts";

const CANON = '{"asset":"BTC","signal":"RISK_OFF"}';
const C = sha256Hex(CANON);
const CHAIN = { status: "finalized", sender: "4dNM", data_text: `veriflow:v1:${C}` };

test("matches the Python verifier", () => {
  assert.ok(allOk(verifyCommitment(C, CHAIN, CANON)));
  assert.ok(!allOk(verifyCommitment(C, CHAIN, CANON.replace("RISK_OFF", "RISK_ON"))));
  assert.ok(!allOk(verifyCommitment(C, { ...CHAIN, data_text: "veriflow:v1:" + "0".repeat(64) }, CANON)));
  assert.ok(!allOk(verifyCommitment(C, { status: "pending" })));
  assert.ok(!allOk(verifyCommitment(C, null)));
  assert.equal(verifyCommitment(C, CHAIN).length, 2);
});

test("anchoring time: within a day of the data close passes, late anchoring fails", () => {
  const canon = '{"as_of":"2026-11-19","asset":"BTC","nonce":"ab","signal":"RISK_ON"}';
  const c = sha256Hex(canon);
  const chain = (block_time: string) => ({ status: "finalized", data_text: `veriflow:v1:${c}`, block_time });
  // 11-19 的日 K 在 11-20 00:00 UTC 收盤，期限是 11-21 00:00 UTC
  const onTime = verifyCommitment(c, chain("2026-11-20T05:00:42.000Z"), canon);
  assert.equal(onTime.length, 4);
  assert.ok(allOk(onTime));
  assert.ok(allOk(verifyCommitment(c, chain("2026-11-20T23:59:59.000Z"), canon)));
  // 等結果出來（7 天後）才補寫：不算數
  const late = verifyCommitment(c, chain("2026-11-27T01:00:00.000Z"), canon);
  assert.ok(!allOk(late));
  assert.match(late[3].detail, /closed 2026-11-20T00:00:00.000Z/);
  // 沒有區塊時間（舊的 gateway）或內容不是 JSON：不做這一項，也不誤判
  assert.equal(verifyCommitment(c, { status: "finalized", data_text: `veriflow:v1:${c}` }, canon).length, 3);
  assert.equal(verifyCommitment(C, { ...CHAIN, block_time: "2030-01-01T00:00:00Z" }, CANON).length, 3);
});
