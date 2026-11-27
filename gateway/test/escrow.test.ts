/** Encoding of the escrow CLI against the contract's layout (contract-escrow/src/lib.rs) */
import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountAddress } from "@concordium/web-sdk";
import { decodeEscrow, encodeInit, encodePay, errorName } from "../src/escrow.ts";

const A = "4Vf4qUg5jWyAJXJ3mR3RHvfu8YXjiNT5asveQFF52FgkjMQ16r";
const W = "3WSAJwTZqVRypnGMkUjW28QDES8h1FUBoCwrzQ1rdN35NGavf8";
const raw = (a: string) => Buffer.from(AccountAddress.fromBase58(a).decodedAddress);
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };

test("pay and init parameters", () => {
  assert.equal(encodePay(1313n, 60, "ab").toString("hex"), "2105000000000000" + "3c000000" + "02000000" + "6162");
  assert.throws(() => encodePay(1n, 1, "x".repeat(65)));
  assert.equal(encodeInit({ index: 12802n, subindex: 0n }).toString("hex"), "0232000000000000" + "0000000000000000");
});

test("error codes follow the contract's enum order", () => {
  assert.equal(errorName(-2), "AgentNotFound");
  assert.equal(errorName(-3), "AgentNotActive");
  assert.equal(errorName(-4), "AgentHasNoWallet");
  assert.equal(errorName(-19), "SelfPayment");
  assert.equal(errorName(-21), "NotPayable");
  assert.equal(errorName(-99), "code -99");
});

test("escrow record decoding", () => {
  const memo = Buffer.from("order-1");
  const buf = Buffer.concat([
    Buffer.from([1]), raw(A), u64(1313n), u64(1_000_000n), u64(1_795_000_000_000n), u64(1_795_003_600_000n), raw(W),
    (() => { const b = Buffer.alloc(4); b.writeUInt32LE(memo.length); return b; })(), memo, Buffer.from([1, 1]), raw(W),
  ]);
  const e = decodeEscrow(buf)!;
  assert.equal(e.buyer, A);
  assert.equal(e.tokenId, "1313");
  assert.equal(e.amountMicroCcd, 1_000_000n);
  assert.equal(e.state, "Released");
  assert.equal(e.paidTo, W);
  assert.equal(e.memo, "order-1");
  assert.equal(decodeEscrow(Buffer.from([0])), null);
});
