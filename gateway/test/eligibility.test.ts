/**
 * 資格驗證的規則測試（鏈上部分用假的 Chain 取代，不需要網路）
 * 執行：npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EligibilityService,
  EligibilityStore,
  CHALLENGE_TTL_MS,
  buildStatements,
  credIdFromDid,
  idpFromDid,
  parseCountries,
  payerOf,
  statementGap,
  type Chain,
} from "../src/eligibility.ts";

const BUYER = "2xBpaHottqhwFZURMZW4uZduQvpxNDSy46iXMYs9kceNGaPpZX"; // 測試用地址（32 個 0x01）
const OTHER = "2xdTv8awN1BjgYEw8W1BVXVtiEwG2b29U8KoZQqJrDuEqddseE";
const POLICY = { minAge: 18, restrictedCountries: ["KP", "US"] };

function presentation(credId = "ab12", idp = 0) {
  return JSON.stringify({
    presentationContext: "x",
    proof: { created: "2026-11-18T00:00:00Z", proofValue: [], type: "ConcordiumWeakLinkingProofV1" },
    type: "VerifiablePresentation",
    verifiableCredential: [
      {
        credentialSubject: { id: `did:ccd:testnet:cred:${credId}`, proof: {}, statement: [] },
        issuer: `did:ccd:testnet:idp:${idp}`,
        type: ["VerifiableCredential", "ConcordiumVerifiableCredential"],
      },
    ],
  });
}

/** 假鏈：證明「通過」，回傳指定的 challenge 與條件；credential 屬於 owner */
function fakeChain(opts: { owner?: string; statement?: unknown; challenge?: (c: string) => string; fail?: string } = {}): Chain & { last?: string } {
  const chain: Chain & { last?: string } = {
    async identityProviders() { return [0, 1]; },
    async verify() {
      if (opts.fail) throw new Error(opts.fail);
      const c = chain.last!;
      return {
        challenge: opts.challenge ? opts.challenge(c) : c,
        credentialStatements: [{ id: "did", statement: opts.statement ?? buildStatements(POLICY, [0, 1])[0].statement }],
      };
    },
    async accountOfCredential() { return opts.owner ?? BUYER; },
  };
  return chain;
}

async function run(chain: Chain & { last?: string }, account = BUYER, pres = presentation()) {
  const svc = new EligibilityService(POLICY, new EligibilityStore(), chain);
  const { challenge } = await svc.challenge(account);
  chain.last = challenge;
  return { svc, challenge, result: svc.verify(challenge, pres) };
}

test("valid proof → account becomes eligible", async () => {
  const { svc, result } = await run(fakeChain());
  const rec = await result;
  assert.equal(rec.account, BUYER);
  assert.ok(svc.status(BUYER));
  assert.equal(svc.status(OTHER), null);
});

test("invalid ZK proof is refused", async () => {
  const { svc, result } = await run(fakeChain({ fail: "proof invalid" }));
  await assert.rejects(result, /proof invalid/);
  assert.equal(svc.status(BUYER), null);
});

test("someone else's credential cannot verify my account", async () => {
  const { result } = await run(fakeChain({ owner: OTHER }));
  await assert.rejects(result, /屬於帳號/);
});

test("proof bound to a different challenge (replay) is refused", async () => {
  const { result } = await run(fakeChain({ challenge: () => "00".repeat(32) }));
  await assert.rejects(result, /challenge/);
});

test("challenge can only be used once", async () => {
  const chain = fakeChain();
  const { svc, challenge, result } = await run(chain);
  await result;
  await assert.rejects(svc.verify(challenge, presentation()), /用過/);
});

test("expired challenge is refused", async () => {
  let now = 1_000_000;
  const chain = fakeChain();
  const svc = new EligibilityService(POLICY, new EligibilityStore(undefined, () => now), chain);
  const { challenge } = await svc.challenge(BUYER);
  chain.last = challenge;
  now += CHALLENGE_TTL_MS + 1;
  await assert.rejects(svc.verify(challenge, presentation()), /過期/);
});

test("weaker statement (younger age bound / fewer restricted countries) is refused", async () => {
  const [age, region] = buildStatements(POLICY, [0])[0].statement as any[];
  await assert.rejects((await run(fakeChain({ statement: [{ ...age, upper: "20991231" }, region] }))).result, /dob/);
  await assert.rejects((await run(fakeChain({ statement: [age, { ...region, set: ["KP"] }] }))).result, /US/);
  await assert.rejects((await run(fakeChain({ statement: [age] }))).result, /缺少/);
});

test("unknown identity provider is refused", async () => {
  const { result } = await run(fakeChain(), BUYER, presentation("ab12", 9));
  await assert.rejects(result, /身份提供者/);
});

test("changing the policy invalidates earlier verifications", async () => {
  const store = new EligibilityStore();
  const chain = fakeChain();
  const svc = new EligibilityService(POLICY, store, chain);
  const { challenge } = await svc.challenge(BUYER);
  chain.last = challenge;
  await svc.verify(challenge, presentation());
  const stricter = new EligibilityService({ ...POLICY, restrictedCountries: ["KP", "US", "DK"] }, store, chain);
  assert.equal(stricter.status(BUYER), null);
});

test("helpers", () => {
  assert.deepEqual(parseCountries(" us,kp , x1,DK"), ["DK", "KP", "US"]);
  assert.equal(credIdFromDid("did:ccd:testnet:cred:abc123"), "abc123");
  assert.equal(idpFromDid("did:ccd:testnet:idp:3"), 3);
  assert.throws(() => credIdFromDid("did:ccd:testnet:idp:3"));
  assert.equal(statementGap([], []), null);
});

test("payer is read from the signed x402 Concordium transaction", () => {
  assert.equal(payerOf({ signedTransaction: { header: { sender: BUYER } } }), BUYER);
  assert.equal(payerOf({ header: { sender: BUYER } }), undefined);
  assert.equal(payerOf(undefined), undefined);
});
