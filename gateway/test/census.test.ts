/**
 * 普查的純函式：統計、Card 內網址、x402 402 解析（不需要連線）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptsOf402, summarize, urlsIn, type Row } from "../src/census.ts";

test("summary counts and the 'payable safely' definition", () => {
  const rows: Row[] = [
    { id: "1", status: "Active", wallet: true, card: "ok", hashMatch: true, badge: true },
    { id: "2", status: "Active", wallet: false, card: "ok", hashMatch: true },
    { id: "3", status: "Active", wallet: true, card: "ok", hashMatch: false },
    { id: "4", status: "Active", wallet: true, card: "unreachable" },
    { id: "5", status: "Revoked", wallet: true },
    { id: "6", status: "unreadable", extRef: true },
    { id: "7", status: "Active", wallet: true, card: "ok", hashMatch: true, mentionsX402: true, x402: { url: "https://a", networks: ["ccd:x"], ccdPayToMatchesWallet: false, evmPayTo: false, cis8Key: false } },
  ];
  const s = summarize(rows);
  assert.equal(s.agents, 7);
  assert.equal(s.active, 5);
  assert.equal(s.revoked, 1);
  assert.equal(s.with_external_reference, 1);
  assert.equal(s.payable_safely, 2); // ids 1 and 7
  assert.equal(s.payable_safely_pct_of_active, 40);
  assert.equal(s.active_hash_mismatch, 1);
  assert.equal(s.x402_ccd_payto_not_wallet, 1);
});

test("urls in a card: https only, deduplicated, without the card's own URL", () => {
  const card = { url: "https://a.example/api", skills: [{ endpoint: "https://a.example/api" }, { x: "http://insecure" }], self: "https://a.example/card.json", t: "see https://b in text" };
  assert.deepEqual(urlsIn(card, "https://a.example/card.json"), ["https://a.example/api"]);
});

test("402 parsing: v1 JSON body, garbage, empty", () => {
  assert.deepEqual(acceptsOf402(null, JSON.stringify({ accepts: [{ network: "base-sepolia", payTo: "0x1" }] })), [{ network: "base-sepolia", payTo: "0x1" }]);
  assert.deepEqual(acceptsOf402("not-base64", "nope"), []);
  assert.deepEqual(acceptsOf402(null, "{}"), []);
});

import { decodeAgentOf } from "../src/registry-node.ts";
import { AccountAddress } from "@concordium/web-sdk";

test("agentOf decodes a CIS-8 external_reference and the fields after it", () => {
  const owner = "4dNMXmNKa2i5hvABfbRJ6NebGopaWSPNmMrbvroSzgJF5wjUNt";
  const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
  const s = (x: string) => Buffer.concat([u32(Buffer.byteLength(x)), Buffer.from(x)]);
  const pk = Buffer.from("03" + "ab".repeat(32), "hex");
  const acct = Buffer.from(AccountAddress.fromBase58(owner).decodedAddress);
  const buf = Buffer.concat([
    Buffer.from([1, 8]), u64(5120n), acct,
    Buffer.from([0]), Buffer.from([0]), // no uri, no hash
    Buffer.from([1]), u64(10081n), u64(0n), Buffer.from([0]), s("eip155:8453"), s("secp256k1-compressed"), u32(pk.length), pk,
    Buffer.from([1]), acct, // wallet
    Buffer.from([0]), u64(0n), Buffer.from([0]), Buffer.from([0]),
  ]);
  const a = decodeAgentOf(buf)!;
  assert.equal(a.tokenId, "5120");
  assert.equal(a.status, "Active");
  assert.equal(a.wallet, owner);
  assert.deepEqual(a.externalRef, { contract: "<10081,0>", namespace: "eip155:8453", keyType: "secp256k1-compressed", publicKey: pk.toString("hex") });
  // 未定義的 kind：拒絕
  const bad = Buffer.from(buf); bad[2 + 8 + 32 + 2 + 1 + 16] = 7;
  assert.throws(() => decodeAgentOf(bad), /unknown external_reference kind/);
});
