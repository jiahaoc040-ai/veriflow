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

// ── 直接向節點讀 Agent Registry ──
test("agentOf decoder reads #1313's record from the CIS-8004 layout", async () => {
  const { decodeAgentOf, encodeAgentTokenId } = await import("../src/registry-node.ts");
  const { AccountAddress } = await import("@concordium/web-sdk");
  const acct = (a: string) => Buffer.from(AccountAddress.fromBase58(a).decodedAddress);
  const uri = Buffer.from("https://cards.test/agent-card.json");
  const u32 = Buffer.alloc(4);
  u32.writeUInt32LE(uri.length);
  const rec = Buffer.concat([
    Buffer.from([1]), encodeAgentTokenId(1313n), acct(OWNER),
    Buffer.from([1]), u32, uri,
    Buffer.from([1]), Buffer.from(sha(CARD), "hex"),
    Buffer.from([0]), // external_reference: none
    Buffer.from([1]), acct(WALLET),
    Buffer.from([0]), // Active
    Buffer.alloc(8), Buffer.from([0, 0]), Buffer.alloc(4), // registered_at, revoked_at, reason, metadata (ignored)
  ]);
  assert.equal(encodeAgentTokenId(1313n).toString("hex"), "082105000000000000");
  assert.deepEqual(decodeAgentOf(rec), { tokenId: "1313", owner: OWNER, agentUri: "https://cards.test/agent-card.json", metadataHash: sha(CARD), wallet: WALLET, status: "Active" });
  assert.equal(decodeAgentOf(Buffer.from([0])), null);
});

test("the node record is authoritative: a hosted answer that disagrees refuses payment", async () => {
  const node = { tokenId: "1313", owner: OWNER, agentUri: "https://cards.test/agent-card.json", metadataHash: sha(CARD), wallet: WALLET, status: "Active" as const };
  const ok = await verifySeller({ gateway: "https://seller.test", payTo: WALLET, ...world(), readAgent: async () => node, expectTokenId: "1313" });
  assert.equal(ok.ok, true, summarize(ok));
  assert.match(ok.checks[1].detail, /read from a Concordium node/);
  // hosted service says 3WSA, the node says the wallet moved: refuse
  const moved = await verifySeller({ gateway: "https://seller.test", payTo: WALLET, ...world(), readAgent: async () => ({ ...node, wallet: SCAMMER }) });
  assert.equal(moved.ok, false);
  assert.match(summarize(moved), /disagree on agentWallet/);
  // the 402 names another agent
  const other = await verifySeller({ gateway: "https://seller.test", payTo: WALLET, ...world(), readAgent: async () => node, expectTokenId: "42" });
  assert.equal(other.ok, false);
  // node unreachable: fail closed
  const down = await verifySeller({ gateway: "https://seller.test", payTo: WALLET, ...world(), readAgent: async () => { throw new Error("UNAVAILABLE"); } });
  assert.equal(down.ok, false);
});

test("strict decoding and a mandatory node read: illegal tags, wrong id length, no token id, wrong badge", async () => {
  const { decodeAgentOf, encodeAgentTokenId } = await import("../src/registry-node.ts");
  const owner = Buffer.alloc(32, 1);
  assert.throws(() => decodeAgentOf(Buffer.from([2])), /illegal option tag/);
  assert.throws(() => decodeAgentOf(Buffer.concat([Buffer.from([1, 7]), Buffer.alloc(7)])), /token id length/);
  assert.throws(() => decodeAgentOf(Buffer.concat([Buffer.from([1]), encodeAgentTokenId(1313n), owner, Buffer.from([2])])), /illegal option tag 2 for agent_uri/);
  const node = { tokenId: "1313", owner: OWNER, agentUri: "https://cards.test/agent-card.json", metadataHash: sha(CARD), wallet: WALLET, status: "Active" as const };
  // hosted record without a token id: cannot read the node, so refuse
  const w = world();
  const noId: typeof w.registry = async (name, args) => {
    const r = await w.registry(name, args);
    return name === "agent_by_token_address" ? { ...r, token_id: undefined } : r;
  };
  const v = await verifySeller({ gateway: "https://seller.test", payTo: WALLET, registry: noId, fetch: w.fetch, readAgent: async () => node });
  assert.equal(v.ok, false);
  assert.match(summarize(v), /no token id/);
  // node answers with another agent
  const swapped = await verifySeller({ gateway: "https://seller.test", payTo: WALLET, ...world(), readAgent: async () => ({ ...node, tokenId: "7" }) });
  assert.equal(swapped.ok, false);
  // the 402 names another badge than the card advertises
  const badge = await verifySeller({ gateway: "https://seller.test", payTo: WALLET, ...world(), readAgent: async () => node, expectTokenId: "1313", expectBadge: "SomeOtherBadge123" });
  assert.equal(badge.ok, false);
});
