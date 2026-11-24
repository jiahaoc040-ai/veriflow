import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountAddress, CcdAmount } from "@concordium/web-sdk";
import { transferOf } from "../src/settle-recovery.ts";

const A = "4Vf4qUg5jWyAJXJ3mR3RHvfu8YXjiNT5asveQFF52FgkjMQ16r";
const B = "3WSAJwTZqVRypnGMkUjW28QDES8h1FUBoCwrzQ1rdN35NGavf8";

test("reads sender, receiver and amount from SDK-typed and plain summaries", () => {
  const typed = { sender: AccountAddress.fromBase58(A), transactionType: "transfer", transfer: { to: AccountAddress.fromBase58(B), amount: CcdAmount.fromMicroCcd(1_000_000n) } };
  assert.deepEqual(transferOf(typed), { sender: A, to: B, amount: 1_000_000n });
  const plain = { sender: A, transfer: { to: B, amount: "1000000" } };
  assert.deepEqual(transferOf(plain), { sender: A, to: B, amount: 1_000_000n });
  assert.equal(transferOf({ sender: A }).amount, undefined);
});
