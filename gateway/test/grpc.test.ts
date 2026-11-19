import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransient } from "../src/grpc.ts";

test("network blips are transient, payment problems are not", () => {
  assert.ok(isTransient("signature_verification_failed: read ETIMEDOUT"));
  assert.ok(isTransient(Object.assign(new Error("boom"), { code: "UNAVAILABLE" })));
  assert.ok(isTransient(new Error("Deadline exceeded")));
  assert.ok(!isTransient("insufficient_funds"));
  assert.ok(!isTransient("invalid_signature"));
});
