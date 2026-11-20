/** TypeScript client encodes/decodes exactly like the Rust contract (fixtures from `cargo run --example fixtures`) */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decodeCommitmentRecord,
  decodeCommittedEvent,
  decodeSummary,
  encodeCommit,
  encodeInit,
  encodeReveal,
} from "../src/contract.ts";

const fx = JSON.parse(readFileSync(new URL("./contract-fixtures.json", import.meta.url), "utf8"));
const C = "ab".repeat(32);
const hex = (b: Buffer) => b.toString("hex");

test("parameters match Rust serialization", () => {
  assert.equal(hex(encodeInit(604_800_000n)), fx.init);
  assert.equal(hex(encodeCommit(C, "BTC")), fx.commit);
  assert.equal(hex(encodeReveal('{"signal":"RISK_ON"}')), fx.reveal);
  assert.throws(() => encodeCommit("xyz", "BTC"));
});

test("return values decode like Rust serialized them", () => {
  assert.deepEqual(decodeCommitmentRecord(Buffer.from(fx.record_revealed, "hex")), {
    asset: "BTC",
    committed_at: new Date(1_763_000_000_000).toISOString(),
    reveal: { signal: "RISK_OFF", revealed_at: new Date(1_763_604_800_000).toISOString(), canonical: '{"signal":"RISK_OFF"}' },
  });
  assert.deepEqual(decodeCommitmentRecord(Buffer.from(fx.record_unrevealed, "hex")), {
    asset: "ETH",
    committed_at: new Date(5).toISOString(),
    reveal: null,
  });
  assert.equal(decodeCommitmentRecord(Buffer.from(fx.record_none, "hex")), null);
  const s = decodeSummary(Buffer.from(fx.summary, "hex"));
  assert.deepEqual({ ...s, owner: undefined }, { owner: undefined, horizon_days: 7, issued: 3, revealed: 1 });
});

test("Committed event decodes to the commitment", () => {
  assert.deepEqual(decodeCommittedEvent(fx.event_committed), { commitment: C, asset: "BTC" });
  assert.equal(decodeCommittedEvent("01" + "00".repeat(40)), null);
});
