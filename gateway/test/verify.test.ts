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
