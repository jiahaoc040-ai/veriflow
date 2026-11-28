/**
 * The buyer-proof requirement as one top-level x402 extension (x402 #4182, restructured shape): its info validates against its own schema
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { buyerProofExtension, BUYER_PROOF_EXTENSION } from "../src/buyer-proof.ts";

const ext = buyerProofExtension({
  facts: ["adult", "region"],
  policy: { id: "p1", minAge: 18, restrictedCountries: ["KP"] },
  verifyUrl: "https://example.test/verify",
  network: "ccd:4221332d34e1694168c2a0c0b3fd0f27",
})[BUYER_PROOF_EXTENSION];

test("info matches the extension's own schema", () => {
  const ajv = new (Ajv2020 as unknown as typeof Ajv2020.default)({ strict: false });
  const ok = ajv.validate(ext.schema, ext.info);
  assert.equal(ok, true, JSON.stringify(ajv.errors));
});

test("one requirement for every accepts entry; facts and assurance stated apart from the binding", () => {
  assert.equal(ext.info.appliesTo, "all-accepts");
  assert.deepEqual(ext.info.facts, ["adult", "region"]);
  assert.equal(ext.info.assurance.id, "p1");
  assert.equal(ext.info.methods.length, 1);
  assert.equal(ext.info.methods[0].type, "concordium-account-proof");
  assert.match(ext.info.methods[0].binding, /signedTransaction\.header\.sender/);
  assert.equal(ext.info.refusal, "buyer_proof_required");
});
