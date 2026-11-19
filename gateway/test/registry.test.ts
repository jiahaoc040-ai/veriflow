import { test } from "node:test";
import assert from "node:assert/strict";
import { mintedTokenId } from "../src/registry.ts";

test("token id from a real testnet CIS-8004 Registered event (token 1263)", () => {
  const registered = "f008ef04000000000000eab0d16830f54c9b5b32f9c0088d084471540ac25cf63600e812afd60bf265fb01";
  assert.equal(mintedTokenId(["ff00", registered]), "1263");
});

test("token id from a CIS-2 Mint event; ignores unrelated events", () => {
  assert.equal(mintedTokenId(["fe080500000000000000" + "01" + "00".repeat(33)]), "5");
  assert.equal(mintedTokenId(["fb01", "ab"]), undefined);
});
