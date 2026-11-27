import { test } from "node:test";
import assert from "node:assert/strict";
import { recheckRecord } from "../src/eligibility.ts";

test("re-check record: payment, payer, audit record and policy, within registerData's 256 bytes", () => {
  const tx = "c14f5dfc38aca3d14b12ec36e6e51ee4fe210922406865ebf048a579c792ef1a";
  const vaa = "70df5beb5d318803a340dc60457225b6417393bfdc970b6d892a6c063a9e6795";
  const payer = "3GdS46Ep1g76SJKgFKt5kBBvUTk4wGcmnAuN932pUYfxVrveHz";
  const r = recheckRecord(tx, payer, vaa, "6e1654b535197b23");
  assert.equal(r, `veriflow:recheck:v1:${tx}:${payer}:${vaa}:6e1654b535197b23`);
  assert.ok(new TextEncoder().encode(r).length <= 256);
  assert.throws(() => recheckRecord("zz", payer, vaa, "p"));
  assert.throws(() => recheckRecord(tx, "0x1234", vaa, "p"));
});
