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
