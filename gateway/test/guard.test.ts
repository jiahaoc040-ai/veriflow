/**
 * Seller guard for any x402 client: fake registry, node, cards and delivery records, no network access
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { checkSellerFor, namedAgentOf, reputationPasses, summarize, type GuardDeps } from "../src/guard.ts";
import type { AgentOnChain } from "../src/registry-node.ts";

const NET = "ccd:4221332d34e1694168c2a0c0b3fd0f27";
const TOKEN = "JyP9Y5PqyaZge2fzDzyQa";
const OWNER = "3p6DTnSwRwczJL5JxmB89jveUFJq6x6npc1azREG7bzXvQiP6c";
const WALLET = "4J2SFgeVrLHVqPkb3dczpYKP99wFMm7FDFp3fEPwXMff3ieLi2";
const OTHER = "3ZXiUAM8TYs1c9RfocVN6fude9vUnETLVGg3Tdk5vgSQhFi63D";
const CARD = JSON.stringify({ name: "Some seller", capabilities: { extensions: [{ uri: "https://docs.concordium.com/a2a-extensions/concordium-badge/v1", params: { tokenAddress: `${NET}/cis-2:${TOKEN}` } }] } });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function deps(o: { verdict?: string; repDown?: boolean; wallet?: string } = {}) {
  const asked: string[] = [];
  const node: AgentOnChain = { tokenId: "990", owner: OWNER, agentUri: "https://seller.test/.well-known/agent-card.json", metadataHash: sha(CARD), wallet: o.wallet ?? WALLET, status: "Active" } as AgentOnChain;
  const d: GuardDeps = {
    registryNetwork: "testnet",
    concordiumNetwork: NET,
    registryAddress: "12802.0",
    registry: async (name) => {
      if (name === "agent_by_token_address") return { token_id: node.tokenId, owner_account: OWNER, agent_uri: node.agentUri, metadata_hash_hex: node.metadataHash, agent_wallet: node.wallet, status: "Active" };
      if (name === "check_badge") return { badge_valid: true, checks: { ok: true } };
      throw new Error(name);
    },
    readAgent: async () => node,
    fetch: (async (url: string) => {
      asked.push(url);
      if (url === "https://seller.test/.well-known/agent-card.json") return new Response(CARD);
      if (url.startsWith("https://rep.test/check?agent=")) {
        if (o.repDown) throw new Error("ECONNREFUSED");
        return Response.json({ vet402: { verdict: o.verdict ?? "go", N: 1 }, trust_summary: { line: "badge go" } });
      }
      return new Response("nope", { status: 404 });
    }) as typeof fetch,
  };
  return { d, asked };
}
const req = (payTo = WALLET) => ({ network: NET, payTo, amount: "500000", asset: "CCD" });
const run = (o: Parameters<typeof deps>[0] = {}, payTo = WALLET, policy: Parameters<typeof checkSellerFor>[2] = { reputationUrl: "https://rep.test" }) => {
  const { d, asked } = deps(o);
  return checkSellerFor({ origin: "https://seller.test", req: req(payTo) }, d, policy).then((v) => ({ v, asked }));
};

test("a seller that is not ours, honest and delivering: 5 chain checks + delivery record pass", async () => {
  const { v } = await run();
  assert.equal(v.ok, true, summarize(v));
  assert.equal(v.checks.length, 6);
  assert.equal(v.tokenId, "990");
  assert.match(summarize(v), /seller verified: agent #990.*delivery record: go/);
});

test("payTo is not the agent's on-chain wallet → refused, and the third party is not even asked", async () => {
  const { v, asked } = await run({}, OTHER);
  assert.equal(v.ok, false);
  assert.equal(v.checks.length, 5);
  assert.equal(v.checks[4].ok, false);
  assert.ok(!asked.some((u) => u.startsWith("https://rep.test")));
});

test("proven non-delivery (verdict no) blocks by default; advisory only reports it", async () => {
  assert.equal((await run({ verdict: "no" })).v.ok, false);
  assert.match(summarize((await run({ verdict: "no" })).v), /refused to pay: independent delivery record/);
  assert.equal((await run({ verdict: "no" }, WALLET, { reputation: "advisory", reputationUrl: "https://rep.test" })).v.ok, true);
});

test("unproven or unreachable record does not block by default; require-go demands a go", async () => {
  assert.equal((await run({ verdict: "unproven" })).v.ok, true);
  assert.equal((await run({ repDown: true })).v.ok, true);
  assert.equal((await run({ verdict: "unproven" }, WALLET, { reputation: "require-go", reputationUrl: "https://rep.test" })).v.ok, false);
  assert.equal((await run({}, WALLET, { reputation: "off" })).v.checks.length, 5);
});

test("policy requireNamedAgent: an unnamed seller is refused before anything is fetched", async () => {
  const { v, asked } = await run({}, WALLET, { requireNamedAgent: true });
  assert.equal(v.ok, false);
  assert.match(v.checks[0].detail, /does not name itself/);
  assert.equal(asked.length, 0);
});

test("namedAgentOf: right registry and network, wrong registry, none", () => {
  const pr = (info: unknown) => ({ extensions: { "concordium-agent": { info } } });
  assert.equal(namedAgentOf(pr({ network: NET, registry: "12802.0", tokenId: "1313", badge: "B" }), NET, "12802.0"), "1313|B");
  assert.equal(namedAgentOf(pr({ network: NET, registry: "10082.0", tokenId: "1313" }), NET, "12802.0"), "mismatch");
  assert.equal(namedAgentOf({}, NET, "12802.0"), "unnamed");
});

test("reputationPasses table", () => {
  assert.deepEqual(["go", "no", "unproven", "unreachable"].map((v) => reputationPasses(v, "block-no")), [true, false, true, true]);
  assert.deepEqual(["go", "no", "unproven"].map((v) => reputationPasses(v, "require-go")), [true, false, false]);
  assert.deepEqual(["go", "no"].map((v) => reputationPasses(v, "advisory")), [true, true]);
});

test("an EVM payTo with no way to check it is refused", async () => {
  const { d } = deps();
  const v = await checkSellerFor({ origin: "https://seller.test", req: { network: "eip155:84532", payTo: "0xabc" } }, d, { reputation: "off" });
  assert.equal(v.ok, false);
});

test("uncompressed(): compressed and uncompressed forms give the same 65-byte key", async () => {
  const { uncompressed } = await import("../src/guard-deps.ts");
  const { compressPublicKey } = await import("../src/cis8.ts");
  const { secp256k1 } = await import("@noble/curves/secp256k1.js");
  const pub = Buffer.from(secp256k1.getPublicKey("11".repeat(32), false)).toString("hex");
  assert.equal(uncompressed(compressPublicKey(pub).toString("hex")), pub);
  assert.equal(uncompressed("0x" + pub), pub);
  assert.throws(() => uncompressed("02" + "00".repeat(32)));
});

test("node reads are retried on a dropped connection or a 429, not on other errors", async () => {
  const { retrying } = await import("../src/guard-deps.ts");
  let n = 0;
  assert.equal(await retrying(async () => { if (++n < 3) throw new Error("No connection established. Last error: read ECONNRESET"); return "ok"; }, 3), "ok");
  n = 0;
  await assert.rejects(retrying(async () => { n++; throw new Error("agentOf: illegal option tag 7"); }, 3), /illegal/);
  assert.equal(n, 1);
});
