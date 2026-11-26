/**
 * Fixes from an outside review of 0.1.0: each test is one concrete input the review showed passing when it should not
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { AccountAddress } from "@concordium/web-sdk";
import { checkSellerFor, protect, type GuardDeps } from "../src/guard.ts";
import { boundAs, concordiumGuardDeps, HttpStatusError, isTransient, registryMcp, retrying } from "../src/deps.ts";
import { cardUrlAllowed, sameAccountSafe } from "../src/seller.ts";
import { sameExternalKey } from "../src/cis8.ts";
import type { AgentOnChain } from "../src/agent-record.ts";

const NET = "ccd:4221332d34e1694168c2a0c0b3fd0f27";
const MAINNET = "ccd:9dd9ca4d19e9393877d2c44b70f89acb";
const TOKEN = "JyP9Y5PqyaZge2fzDzyQa";
const OWNER = "3p6DTnSwRwczJL5JxmB89jveUFJq6x6npc1azREG7bzXvQiP6c";
const WALLET = "4J2SFgeVrLHVqPkb3dczpYKP99wFMm7FDFp3fEPwXMff3ieLi2";
const OTHER = "3ZXiUAM8TYs1c9RfocVN6fude9vUnETLVGg3Tdk5vgSQhFi63D";
const CARD = JSON.stringify({ name: "Some seller", capabilities: { extensions: [{ uri: "https://docs.concordium.com/a2a-extensions/concordium-badge/v1", params: { tokenAddress: `${NET}/cis-2:${TOKEN}` } }] } });
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const G = "0479be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
const Gc = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

/** Another base58 alias of the same account: same first 29 bytes, different last 3 */
function aliasOf(addr: string): string {
  const b = Buffer.from(AccountAddress.fromBase58(addr).decodedAddress);
  b[31] ^= 0x01;
  return AccountAddress.fromBuffer(b).address;
}

function deps(o: { uri?: string; badge?: unknown; rep?: () => Response; wallet?: string } = {}) {
  const asked: string[] = [];
  const uri = o.uri ?? "https://seller.test/.well-known/agent-card.json";
  const node = { tokenId: "990", owner: OWNER, agentUri: uri, metadataHash: sha(CARD), wallet: o.wallet ?? WALLET, status: "Active" } as AgentOnChain;
  const d: GuardDeps = {
    registryNetwork: "testnet",
    concordiumNetwork: NET,
    registryAddress: "12802.0",
    registry: async (name) => {
      if (name === "agent_by_token_address") return { token_id: "990", owner_account: OWNER, agent_uri: uri, metadata_hash_hex: node.metadataHash, agent_wallet: node.wallet, status: "Active" };
      if (name === "check_badge") return o.badge ?? { badge_valid: true, checks: { ok: true } };
      throw new Error(name);
    },
    readAgent: async () => node,
    isEvmNetwork: (n) => n.startsWith("eip155:"),
    evmNetworks: ["eip155:84532"],
    evmPayToCheck: () => async () => ({ name: "payTo bound in CIS-8", ok: true, detail: "stub" }),
    fetch: (async (url: string) => {
      asked.push(url);
      if (url === "https://seller.test/.well-known/agent-card.json") return new Response(CARD);
      if (url.startsWith("https://rep.test/")) return o.rep ? o.rep() : Response.json({ vet402: { verdict: "go" } });
      return new Response("nope", { status: 404 });
    }) as typeof fetch,
  };
  return { d, asked };
}
const check = (d: GuardDeps, req: { network: string; payTo: string; extra?: Record<string, unknown> }, policy = { reputationUrl: "https://rep.test" }) =>
  checkSellerFor({ origin: "https://seller.test", req: { amount: "1", asset: "CCD", ...req } }, d, policy);

test("network pinning: testnet checks never approve a payment on mainnet CCD or on another EVM chain", async () => {
  const { d, asked } = deps();
  const v = await check(d, { network: MAINNET, payTo: WALLET });
  assert.equal(v.ok, false);
  assert.match(v.checks[0].detail, /reads Concordium testnet/);
  assert.equal(asked.length, 0, "nothing is fetched");
  const base = await check(d, { network: "eip155:8453", payTo: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf" });
  assert.equal(base.ok, false);
  assert.match(base.checks[0].detail, /eip155:84532, not eip155:8453/);
  assert.equal((await check(d, { network: NET, payTo: WALLET })).ok, true);
});

test("official badge check: badge_valid with a failed sub-check is a fail", async () => {
  const { d } = deps({ badge: { badge_valid: true, checks: { owner_matches: false, ok: true } } });
  const v = await check(d, { network: NET, payTo: WALLET });
  assert.equal(v.ok, false);
  assert.ok(v.checks.some((c) => !c.ok && /owner_matches/.test(c.detail)));
});

test("Agent Card URL: https public hosts only; loopback, private, link-local, ULA and mapped IPv4 are refused unless the test flag is set", () => {
  for (const bad of ["http://seller.test/card", "http://127.0.0.1:6379/", "https://127.0.0.1/", "https://10.0.0.1/", "https://192.168.1.2/", "https://172.16.0.1/", "https://169.254.169.254/", "https://[::1]/", "https://[fd00::1]/", "https://[fe80::1]/", "https://[::ffff:127.0.0.1]/", "https://localhost/", "https://0.0.0.0/", "ftp://x.test/"])
    assert.throws(() => cardUrlAllowed(bad), undefined, bad);
  cardUrlAllowed("https://seller.test/.well-known/agent-card.json");
  cardUrlAllowed("http://127.0.0.1:8080/card", true);
});

test("a card on a private address is never fetched", async () => {
  const { d, asked } = deps({ uri: "http://127.0.0.1:6379/" });
  const v = await check(d, { network: NET, payTo: WALLET });
  assert.equal(v.ok, false);
  assert.ok(!asked.some((u) => u.includes("127.0.0.1")));
});

test("CCD payTo: another alias of the agent's wallet is the same account; a different account is not", async () => {
  const alias = aliasOf(WALLET);
  assert.notEqual(alias, WALLET);
  assert.equal(sameAccountSafe(alias, WALLET), true);
  assert.equal(sameAccountSafe(OTHER, WALLET), false);
  assert.equal(sameAccountSafe("not-an-address", WALLET), false);
  const { d } = deps();
  assert.equal((await check(d, { network: NET, payTo: alias })).ok, true);
});

test("delivery record: verdict is case-insensitive ('NO' blocks), a huge body is unreadable, not a crash", async () => {
  assert.equal((await check(deps({ rep: () => Response.json({ vet402: { verdict: "NO" } }) }).d, { network: NET, payTo: WALLET })).ok, false);
  const huge = deps({ rep: () => new Response("x".repeat(200_000)) });
  const v = await check(huge.d, { network: NET, payTo: WALLET });
  assert.equal(v.ok, true, "block-no: an unreadable record does not block (documented: check 6 is not fail-closed)");
  assert.match(v.checks[5].detail, /no usable answer.*larger than 65536/);
  const strict = await check(huge.d, { network: NET, payTo: WALLET }, { reputationUrl: "https://rep.test", reputation: "require-go" } as never);
  assert.equal(strict.ok, false);
});

test("retries: Node fetch's error.cause, timeouts and HTTP 429/5xx are transient; a tool error mentioning 500 is not", async () => {
  const fetchFailed = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:59999"), { code: "ECONNREFUSED" }) });
  assert.equal(isTransient(fetchFailed), true);
  assert.equal(isTransient(new DOMException("The operation was aborted due to timeout", "TimeoutError")), true);
  assert.equal(isTransient(new HttpStatusError(503)), true);
  assert.equal(isTransient(Object.assign(new Error("x"), { code: 14 })), true);
  assert.equal(isTransient(new Error("agent_by_token_address: no agent 500 found")), false);
  let n = 0;
  await retrying(async () => { if (++n < 3) throw fetchFailed; return 1; }, 3, 1);
  assert.equal(n, 3);
  let resets = 0;
  n = 0;
  await retrying(async () => { if (++n < 2) throw new HttpStatusError(429); return 1; }, 3, 1, () => resets++);
  assert.equal(resets, 1);
});

test("registryMcp: no redirects, 429/5xx thrown as HTTP status, body capped", async () => {
  let init: RequestInit | undefined;
  const ok = registryMcp("https://r.test/mcp", (async (_u: string, i: RequestInit) => { init = i; return Response.json({ result: { content: [{ text: '{"a":1}' }] } }); }) as typeof fetch);
  assert.deepEqual(await ok("t", {}), { a: 1 });
  assert.equal(init?.redirect, "error");
  await assert.rejects(registryMcp("https://r.test/mcp", (async () => new Response("busy", { status: 503 })) as typeof fetch)("t", {}), (e) => e instanceof HttpStatusError && e.status === 503);
  await assert.rejects(registryMcp("https://r.test/mcp", (async () => new Response("x".repeat(300_000))) as typeof fetch)("t", {}), /over/);
});

test("concordiumGuardDeps: an x402 network id instead of testnet/mainnet is a clear error", () => {
  assert.throws(() => concordiumGuardDeps({ network: "eip155:84532" as never }), /network must be "testnet" or "mainnet"/);
  assert.deepEqual(concordiumGuardDeps({ network: "testnet" }).evmNetworks, ["eip155:84532"]);
  assert.deepEqual(concordiumGuardDeps({ network: "mainnet" }).evmNetworks, ["eip155:8453"]);
});

test("CIS-8 binding owner: the agent's owner or its agentWallet, compared in code; anyone else is refused", () => {
  assert.equal(boundAs(OWNER, { owner: OWNER, wallet: WALLET }), "owner");
  assert.equal(boundAs(aliasOf(WALLET), { owner: OWNER, wallet: WALLET }), "agentWallet");
  assert.equal(boundAs(OTHER, { owner: OWNER, wallet: WALLET }), undefined);
  assert.equal(boundAs("garbage", { owner: OWNER }), undefined);
});

test("sameExternalKey: only secp256k1-compressed/-uncompressed compare as points", () => {
  const k = (keyType: string, publicKey = G) => ({ namespace: "eip155:8453", keyType, publicKey });
  assert.equal(sameExternalKey(k("secp256k1-compressed", Gc), k("secp256k1-uncompressed")), true);
  assert.equal(sameExternalKey(k("secp256k1-FOO"), k("secp256k1-uncompressed")), false);
  assert.equal(sameExternalKey(k("secp256k1x"), k("secp256k1-uncompressed")), false);
});

test("protect accepts any client with onBeforePaymentCreation (structural type)", () => {
  const hooks: unknown[] = [];
  const client = { onBeforePaymentCreation: (h: unknown) => { hooks.push(h); return client; }, register: () => client };
  const { d } = deps();
  const g = protect(client as never, d);
  assert.equal(typeof g.fetch, "function");
  assert.equal(hooks.length, 1);
});

test("a card host name that resolves to a private address is refused", async () => {
  const { cardHostIsPublic, isPrivateAddress } = await import("../src/seller.ts");
  await assert.rejects(cardHostIsPublic("https://localhost/card"), /resolves to a private address/);
  await cardHostIsPublic("https://name-that-does-not-resolve.invalid/card");
  assert.equal(isPrivateAddress("100.64.0.1"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
});
