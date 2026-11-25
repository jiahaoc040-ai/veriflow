import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountAddress } from "@concordium/web-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalBytes, checkEvmBinding, decodeOwnerOfKey, encodeExternalKey, evmAddressOf, EVM_KEY_TYPE, compressPublicKey, sameExternalKey } from "../src/cis8.ts";

const OWNER = "4dNMXmNKa2i5hvABfbRJ6NebGopaWSPNmMrbvroSzgJF5wjUNt";
const acct = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const NS = "eip155:84532";
const key = { namespace: NS, keyType: EVM_KEY_TYPE, publicKey: acct.publicKey };
const le32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const s = (x: string) => Buffer.concat([le32(Buffer.byteLength(x)), Buffer.from(x)]);

test("public key to address matches viem", () => {
  assert.equal(evmAddressOf(acct.publicKey), acct.address);
});

test("canonical bytes follow the CIS-8 layout", () => {
  const g = "11".repeat(32);
  const b = canonicalBytes({ account: OWNER, genesisHash: g, externalNamespace: NS, key, proofScheme: "ethereum-personal-sign" });
  assert.equal(b.subarray(0, 18).toString(), "CIS-8/v1/canonical");
  assert.deepEqual(b.subarray(18, 50), Buffer.from(AccountAddress.fromBase58(OWNER).decodedAddress));
  assert.equal(b.readBigUInt64LE(50), 12801n);
  assert.equal(b.readBigUInt64LE(58), 0n);
  assert.equal(b.subarray(66, 98).toString("hex"), g);
  const rest = Buffer.concat([s(NS), encodeExternalKey(key), s("ethereum-personal-sign")]);
  assert.deepEqual(b.subarray(98), rest);
});

function registration(status = 0, owner = OWNER) {
  return Buffer.concat([Buffer.from([1]), Buffer.from(AccountAddress.fromBase58(owner).decodedAddress), encodeExternalKey(key), s("ethereum-personal-sign"), le32(1), s("role"), s("veriflow"), Buffer.from([status]), Buffer.alloc(8)]);
}

test("decodes ownerOfKey and rejects garbage", () => {
  assert.equal(decodeOwnerOfKey(Buffer.from([0])), null);
  const r = decodeOwnerOfKey(registration());
  assert.equal(r?.owner, OWNER);
  assert.equal(r?.status, "Active");
  assert.equal(r?.key.publicKey, acct.publicKey.slice(2));
  assert.throws(() => decodeOwnerOfKey(Buffer.from([2])));
  assert.throws(() => decodeOwnerOfKey(registration().subarray(0, 40)));
});

test("binding check: right key and owner pass; wrong address, owner, status or missing fail", async () => {
  const read = async () => decodeOwnerOfKey(registration());
  assert.deepEqual(await checkEvmBinding({ address: acct.address, publicKey: acct.publicKey, namespace: NS, expectOwner: OWNER, read }), { ok: true, owner: OWNER });
  assert.equal((await checkEvmBinding({ address: "0x000000000000000000000000000000000000dEaD", publicKey: acct.publicKey, namespace: NS, read })).ok, false);
  assert.equal((await checkEvmBinding({ address: acct.address, publicKey: acct.publicKey, namespace: NS, expectOwner: "4Vf4qUg5jWyAJXJ3mR3RHvfu8YXjiNT5asveQFF52FgkjMQ16r", read })).ok, false);
  assert.equal((await checkEvmBinding({ address: acct.address, publicKey: acct.publicKey, namespace: NS, read: async () => decodeOwnerOfKey(registration(1)) })).ok, false);
  assert.equal((await checkEvmBinding({ address: acct.address, publicKey: acct.publicKey, namespace: NS, read: async () => null })).ok, false);
});

test("live testnet read-back: the contract stores the key compressed, and it still matches the uncompressed query", () => {
  // ownerOfKey on <12801,0> for VeriFlow's seller payTo key, 2026-11-25
  const raw = "01ddaaaad8411ef3c2595d0c9c7f15023a66157665dc8249ac7c9f458ebf3a33230c0000006569703135353a383435333214000000736563703235366b312d636f6d707265737365642100000003eb45b5a140eab832a6af842209e5cb51abbd8cf6c0820fd1b94c80bd201de05c16000000657468657265756d2d706572736f6e616c2d7369676e0100000004000000726f6c651500000076657269666c6f772d73656c6c65722d706179746f0099d18410a2010000";
  const asked = { namespace: "eip155:84532", keyType: "secp256k1-uncompressed", publicKey: "0x04eb45b5a140eab832a6af842209e5cb51abbd8cf6c0820fd1b94c80bd201de05c07a57fbf7ca4bf7a9adc87b65f42e9bd4278845b2e6d36e88b4fde9d9a1cd06f" };
  const r = decodeOwnerOfKey(Buffer.from(raw, "hex"))!;
  assert.equal(r.owner, "4dNMXmNKa2i5hvABfbRJ6NebGopaWSPNmMrbvroSzgJF5wjUNt");
  assert.equal(r.status, "Active");
  assert.equal(r.key.keyType, "secp256k1-compressed");
  assert.equal(compressPublicKey(asked.publicKey).toString("hex"), r.key.publicKey);
  assert.equal(sameExternalKey(r.key, asked), true);
  assert.equal(evmAddressOf(asked.publicKey), "0xdd315C4383bC9aedbE18E7bD954be3718a2F8746");
  // Another key, or another namespace: not the same key
  assert.equal(sameExternalKey(r.key, { ...asked, publicKey: "0x04fef7ae831fcbbc71697d2ce20ec771cbe161f4be20436e018597b449fd630e169a1be4750b544dfff57fe92a02d6297119d53941baccf1b2dfb6052130f86093" }), false);
  assert.equal(sameExternalKey(r.key, { ...asked, namespace: "eip155:8453" }), false);
});
