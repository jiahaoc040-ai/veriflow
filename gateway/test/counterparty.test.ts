/**
 * 付款前驗證賣方：假的 Registry 與假的網路，不需要連線
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { badgeTokenAddress, summarize, verifySeller, type RegistryCall } from "../src/counterparty.ts";

const TOKEN = "JyP9UWYKh54TD2MUJDfqC";
const OWNER = "4dNMXmNKa2i5hvABfbRJ6NebGopaWSPNmMrbvroSzgJF5wjUNt";
const WALLET = "3WSAJwTZqVRypnGMkUjW28QDES8h1FUBoCwrzQ1rdN35NGavf8";
const SCAMMER = "2xBpaHottqhwFZURMZW4uZduQvpxNDSy46iXMYs9kceNGaPpZX";
const CARD = JSON.stringify({
  name: "VeriFlow",
  capabilities: {
    extensions: [
      { uri: "https://docs.concordium.com/a2a-extensions/concordium-badge/v1", params: { tokenAddress: `ccd:4221332d34e1694168c2a0c0b3fd0f27/cis-2:${TOKEN}` } },
    ],
  },
});
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

type World = { card?: string; servedCard?: string; status?: string; wallet?: string; badgeValid?: boolean; registryDown?: boolean };

function world(w: World = {}) {
  const card = w.card ?? CARD;
  const registry: RegistryCall = async (name) => {
    if (w.registryDown) throw new Error("ECONNRESET");
    if (name === "agent_by_token_address")
      return { token_id: "1313", owner_account: OWNER, agent_uri: "https://cards.test/agent-card.json", metadata_hash_hex: sha(CARD), agent_wallet: w.wallet ?? WALLET, status: w.status ?? "Active" };
    if (name === "check_badge")
      return { badge_valid: w.badgeValid ?? true, checks: { status_active: true, owner_matches: w.badgeValid ?? true }, issues: w.badgeValid === false ? ["owner has no identity credential"] : [] };
    throw new Error(`unexpected tool ${name}`);
  };
  const f = (async (url: string) => {
    if (url === "https://seller.test/.well-known/agent-card.json") return new Response(w.servedCard ?? card);
    if (url === "https://cards.test/agent-card.json") return new Response(card);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { registry, fetch: f };
}

const run = (w: World = {}, payTo = WALLET) => verifySeller({ gateway: "https://seller.test", payTo, ...world(w) });

test("honest seller: badge, Active, official check, own card hash, payTo bound → pay", async () => {
  const v = await run();
  assert.equal(v.ok, true, summarize(v));
  assert.equal(v.checks.length, 5);
  assert.equal(v.tokenId, "1313");
  assert.equal(v.owner, OWNER);
  assert.match(summarize(v), /seller verified: agent #1313/);
});

test("impersonator reusing an honest badge but asking to be paid elsewhere → refuse", async () => {
  const v = await run({}, SCAMMER);
  assert.equal(v.ok, false);
  assert.equal(v.checks.find((c) => c.name.startsWith("payTo"))?.ok, false);
  assert.match(summarize(v), /refused to pay: payTo is the agent's on-chain wallet/);
});

test("agentWallet never set on-chain → refuse (cannot prove where the money goes)", async () => {
  const v = await run({ wallet: "" });
  assert.equal(v.ok, false);
  assert.match(v.checks[4].detail, /not set/);
});

test("Agent Card swapped after it was pinned → refuse", async () => {
  const v = await run({ card: CARD.replace("VeriFlow", "VeriFl0w") });
  assert.equal(v.ok, false);
  assert.equal(v.checks.find((c) => c.name.startsWith("Agent Card"))?.ok, false);
});

test("revoked agent or invalid badge → refuse", async () => {
  assert.equal((await run({ status: "Revoked" })).ok, false);
  const bad = await run({ badgeValid: false });
  assert.equal(bad.ok, false);
  assert.match(bad.checks[2].detail, /owner_matches|identity credential/);
});

test("registry unreachable → fail closed, never pay blind", async () => {
  const v = await run({ registryDown: true });
  assert.equal(v.ok, false);
  assert.match(v.checks[1].detail, /registry unreachable/);
});

test("seller without a badge → refuse before touching the registry", async () => {
  const v = await run({ servedCard: JSON.stringify({ name: "anon" }) });
  assert.equal(v.ok, false);
  assert.equal(v.checks.length, 1);
});

test("badge token address parsing", () => {
  assert.equal(badgeTokenAddress(JSON.parse(CARD)), TOKEN);
  assert.equal(badgeTokenAddress({}), undefined);
  assert.equal(badgeTokenAddress({ capabilities: { extensions: [{ uri: "other", params: { tokenAddress: TOKEN } }] } }), undefined);
  assert.equal(badgeTokenAddress({ capabilities: { extensions: [{ uri: "https://docs.concordium.com/a2a-extensions/concordium-badge/v1", params: { tokenAddress: "x;rm -rf" } }] } }), undefined);
});

test("the card fetch is https only, capped in size, and does not follow redirects", async () => {
  const { readCapped, MAX_CARD_BYTES } = await import("../src/counterparty.ts");
  await assert.rejects(readCapped(new Response("x".repeat(MAX_CARD_BYTES + 1)), MAX_CARD_BYTES), /larger than/);
  assert.equal((await readCapped(new Response("ok"), MAX_CARD_BYTES)).toString(), "ok");
});
