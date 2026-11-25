import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountAddress } from "@concordium/web-sdk";
import { privateKeyToAccount } from "viem/accounts";
import { canonicalBytes, checkEvmBinding, decodeOwnerOfKey, encodeExternalKey, evmAddressOf, EVM_KEY_TYPE } from "../src/cis8.ts";

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
