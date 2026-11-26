import { test } from "node:test";
import assert from "node:assert/strict";
import { evmAddressOf, checkEvmBinding, decodeAgentOf, encodeAgentTokenId, NETWORKS, concordiumGuardDeps } from "../src/index.ts";

// Private key 1: the public key is the generator point; its address is well known
const G = "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
const ADDR = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";

test("evmAddressOf: compressed or uncompressed key → the right address", () => {
  assert.equal(evmAddressOf(G), ADDR);
  assert.equal(evmAddressOf("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"), ADDR);
});

test("checkEvmBinding: wrong address, unbound, revoked, other owner, bound", async () => {
  const reg = (o: Partial<{ owner: string; status: "Active" | "Revoked"; proofScheme: string }> = {}) => async () => ({ owner: o.owner ?? "A", status: o.status ?? "Active", proofScheme: o.proofScheme ?? "ethereum-personal-sign", key: { namespace: "eip155:8453", keyType: "secp256k1-uncompressed", publicKey: G } });
  const q = { address: ADDR, publicKey: G, namespace: "eip155:8453", expectOwner: "A" };
  assert.equal((await checkEvmBinding({ ...q, address: "0x0000000000000000000000000000000000000001" }, reg())).ok, false);
  assert.equal((await checkEvmBinding(q, async () => null)).ok, false);
  assert.equal((await checkEvmBinding(q, reg({ status: "Revoked" }))).ok, false);
  assert.equal((await checkEvmBinding(q, reg({ owner: "B" }))).ok, false);
  assert.deepEqual(await checkEvmBinding(q, reg()), { ok: true, owner: "A" });
  assert.equal((await checkEvmBinding(q, async () => { throw new Error("UNAVAILABLE"); })).ok, false);
});

test("agent record: token id encoding and strict decoding", () => {
  assert.equal(encodeAgentTokenId(1313n).toString("hex"), "082105000000000000");
  assert.equal(decodeAgentOf(Buffer.from([0])), null);
  assert.throws(() => decodeAgentOf(Buffer.from([2])), /illegal option tag/);
  assert.throws(() => decodeAgentOf(Buffer.from([1, 4])), /token id length/);
});

test("networks and deps wire the published registries", () => {
  assert.equal(NETWORKS.testnet.agentRegistry.index, 12802n);
  assert.equal(NETWORKS.mainnet.agentRegistry.index, 10082n);
  const d = concordiumGuardDeps({ network: "mainnet" });
  assert.equal(d.registryNetwork, "mainnet");
  assert.equal(d.registryAddress, "10082.0");
  assert.equal(d.concordiumNetwork, NETWORKS.mainnet.caip2);
});
