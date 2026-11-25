/**
 * Cross-chain payment: EIP-3009 signature → payer public key → CIS-8 → Concordium account (fake CIS-8 records, no network)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import { concordiumAccountOfEvmPayment, evmPayerOf, isEvmNetwork } from "../src/evm-payer.ts";
import type { Cis8Registration, ExternalKey } from "../src/cis8.ts";

const OWNER = "4Vf4qUg5jWyAJXJ3mR3RHvfu8YXjiNT5asveQFF52FgkjMQ16r";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAY_TO = "0xdd315C4383bC9aedbE18E7bD954be3718a2F8746";
const req = { network: "eip155:84532", asset: USDC, payTo: PAY_TO, amount: "10000", extra: { name: "USDC", version: "2" } };

async function pay(acct = privateKeyToAccount(generatePrivateKey()), signer = acct) {
  const authorization = { from: acct.address, to: PAY_TO, value: "10000", validAfter: "0", validBefore: "9999999999", nonce: `0x${"11".repeat(32)}` as const };
  const signature = await signer.signTypedData({
    domain: { name: "USDC", version: "2", chainId: 84532, verifyingContract: getAddress(USDC) },
    types: { TransferWithAuthorization: [
      { name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" },
    ] },
    primaryType: "TransferWithAuthorization",
    message: { ...authorization, from: getAddress(authorization.from), to: getAddress(PAY_TO), value: 10000n, validAfter: 0n, validBefore: 9999999999n },
  });
  return { acct, payload: { signature, authorization } };
}
const reg = (k: ExternalKey, o: Partial<Cis8Registration> = {}): Cis8Registration => ({ owner: OWNER, status: "Active", proofScheme: "ethereum-personal-sign", key: k, ...o });

test("network detection", () => {
  assert.equal(isEvmNetwork("eip155:84532"), true);
  assert.equal(isEvmNetwork("ccd:4221332d34e1694168c2a0c0b3fd0f27"), false);
});

test("the payer's public key is recovered from the EIP-3009 signature", async () => {
  const { acct, payload } = await pay();
  const r = await evmPayerOf(payload, req);
  assert.ok(r.ok);
  assert.equal(r.ok && r.publicKey.toLowerCase(), acct.publicKey.toLowerCase());
});

test("a payer bound in CIS-8 maps to its Concordium account", async () => {
  const { acct, payload } = await pay();
  const r = await concordiumAccountOfEvmPayment(payload, req, async (k) => (k.publicKey.toLowerCase() === acct.publicKey.toLowerCase() ? reg(k) : null));
  assert.deepEqual(r, { ok: true, from: acct.address, account: OWNER });
});

test("unbound, revoked, or foreign-signed payments are refused", async () => {
  const { payload } = await pay();
  for (const [why, read] of [
    ["unbound", async () => null],
    ["revoked", async (k: ExternalKey) => reg(k, { status: "Revoked" })],
    ["wrong scheme", async (k: ExternalKey) => reg(k, { proofScheme: "other" })],
    ["node down", async () => { throw new Error("timeout"); }],
  ] as const) {
    const r = await concordiumAccountOfEvmPayment(payload, req, read as (k: ExternalKey) => Promise<Cis8Registration | null>);
    assert.equal(r.ok, false, why);
    assert.equal(!r.ok && r.code, "evm_payer_not_bound", why);
  }
  // The authorization says A but B signed it: the recovered address does not match, refuse (even if B is bound)
  const a = privateKeyToAccount(generatePrivateKey());
  const b = privateKeyToAccount(generatePrivateKey());
  const forged = await pay(a, b);
  const r = await concordiumAccountOfEvmPayment(forged.payload, req, async (k) => reg(k));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /not 0x/i);
});

test("an authorization for another payee or amount is refused before any CIS-8 read", async () => {
  const { payload } = await pay();
  let read = 0;
  const r1 = await concordiumAccountOfEvmPayment(payload, { ...req, payTo: "0x0000000000000000000000000000000000000002" }, async () => (read++, null));
  assert.equal(!r1.ok && r1.code, "evm_wrong_payee");
  const r2 = await concordiumAccountOfEvmPayment(payload, { ...req, amount: "20000" }, async () => (read++, null));
  assert.equal(!r2.ok && r2.code, "evm_wrong_amount");
  assert.equal(read, 0);
});

test("Permit2 and malformed payloads are refused", async () => {
  assert.equal((await evmPayerOf({ signature: "0x00", permit2Authorization: {} }, req)).ok, false);
  assert.equal((await evmPayerOf({ authorization: {} }, req)).ok, false);
  const { payload } = await pay();
  assert.equal((await evmPayerOf(payload, { ...req, extra: {} })).ok, false);
});
