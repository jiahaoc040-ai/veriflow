/**
 * 賣方驗證買方 agent：假的鏈上紀錄，不需要連線
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBuyerAgent, parsePolicy } from "../src/buyer-agent.ts";
import type { AgentOnChain } from "../src/registry-node.ts";

const BUYER = "4Vf4qUg5jWyAJXJ3mR3RHvfu8YXjiNT5asveQFF52FgkjMQ16r";
const OTHER = "3WSAJwTZqVRypnGMkUjW28QDES8h1FUBoCwrzQ1rdN35NGavf8";
const OWNER = "4dNMXmNKa2i5hvABfbRJ6NebGopaWSPNmMrbvroSzgJF5wjUNt";
const rec = (o: Partial<AgentOnChain> = {}): AgentOnChain =>
  ({ tokenId: "2001", owner: OWNER, agentUri: "https://x/card.json", metadataHash: "00".repeat(32), wallet: BUYER, status: "Active", ...o }) as AgentOnChain;
const reader = (r: AgentOnChain | null | Error) => async () => {
  if (r instanceof Error) throw r;
  return r;
};

test("policy parsing defaults to optional", () => {
  assert.equal(parsePolicy(undefined), "optional");
  assert.equal(parsePolicy("required"), "required");
  assert.equal(parsePolicy("off"), "off");
  assert.equal(parsePolicy("nonsense"), "optional");
  assert.equal(parsePolicy(" Required "), "required");
});

test("no header: optional sells, required refuses, off ignores", async () => {
  assert.deepEqual(await checkBuyerAgent(undefined, BUYER, "optional", reader(rec())), { ok: true, named: false });
  assert.equal((await checkBuyerAgent(undefined, BUYER, "required", reader(rec()))).ok, false);
  assert.deepEqual(await checkBuyerAgent("2001", OTHER, "off", reader(rec())), { ok: true, named: false });
});

test("a registered, active agent paying from its own agentWallet passes", async () => {
  const r = await checkBuyerAgent("2001", BUYER, "optional", reader(rec()));
  assert.deepEqual(r, { ok: true, named: true, tokenId: "2001", owner: OWNER, wallet: BUYER });
});

test("someone else's agent id is refused: the payer is not its agentWallet", async () => {
  const r = await checkBuyerAgent("2001", OTHER, "optional", reader(rec()));
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.reason : "", /agentWallet/);
  assert.equal(!r.ok ? r.code : "", "wallet_mismatch");
});

test("revoked, missing, walletless, swapped or unreadable agents are refused", async () => {
  for (const [why, r] of [
    ["revoked", rec({ status: "Revoked" })],
    ["missing", null],
    ["no wallet", rec({ wallet: null })],
    ["swapped id", rec({ tokenId: "7" })],
    ["node down", new Error("timeout")],
  ] as const) {
    const out = await checkBuyerAgent("2001", BUYER, "optional", reader(r as AgentOnChain | null | Error));
    assert.equal(out.ok, false, why);
  }
  assert.equal((await checkBuyerAgent("12a", BUYER, "optional", reader(rec()))).ok, false);
  assert.equal((await checkBuyerAgent("2001", undefined, "optional", reader(rec()))).ok, false);
});
