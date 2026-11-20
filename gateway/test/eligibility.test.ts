/**
 * 資格驗證（V1）的規則測試：鏈上部分用假的 Chain 取代，不需要網路
 * 執行：npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EligibilityService,
  EligibilityStore,
  CHALLENGE_TTL_MS,
  buildClaims,
  credIdFromDid,
  idpFromDid,
  parseCountries,
  payerOf,
  statementGap,
  type Atomic,
  type Chain,
  type ParsedPresentation,
} from "../src/eligibility.ts";

const BUYER = "2xBpaHottqhwFZURMZW4uZduQvpxNDSy46iXMYs9kceNGaPpZX"; // 測試用地址（32 個 0x01）
const OTHER = "2xdTv8awN1BjgYEw8W1BVXVtiEwG2b29U8KoZQqJrDuEqddseE";
const POLICY = { minAge: 18, restrictedCountries: ["KP", "US"] };
const WANT = buildClaims(POLICY, [0, 1])[0].statements as Atomic[];

type Opts = {
  owner?: string;
  statement?: Atomic[];
  kind?: "account" | "identity";
  issuer?: number;
  count?: number;
  auditFails?: string;
};

/** 假鏈：記錄有沒有把稽核寫上鏈 */
function fakeChain(o: Opts = {}): Chain & { audits: number; requests: number } {
  const chain = {
    audits: 0,
    requests: 0,
    async identityProviders() { return [0, 1]; },
    async anchorRequest() {
      chain.requests++;
      return { request: {}, json: { type: "ConcordiumVerificationRequestV1" }, txHash: "aa".repeat(32) };
    },
    parsePresentation(): ParsedPresentation {
      const cred = { kind: o.kind ?? ("account" as const), id: "did:ccd:testnet:cred:ab12", issuer: `did:ccd:testnet:idp:${o.issuer ?? 0}`, statement: o.statement ?? WANT };
      return { presentation: {}, credentials: Array(o.count ?? 1).fill(cred) };
    },
    async auditAndAnchor() {
      if (o.auditFails) throw new Error(o.auditFails);
      chain.audits++;
      return "bb".repeat(32);
    },
    async accountOfCredential() { return o.owner ?? BUYER; },
  };
  return chain;
}

async function run(o: Opts = {}, now?: () => number) {
  const chain = fakeChain(o);
  const svc = new EligibilityService(POLICY, new EligibilityStore(undefined, now), chain);
  const { id, requestAnchorTx } = await svc.challenge(BUYER);
  return { svc, chain, id, requestAnchorTx };
}

test("valid proof → eligible, with request (VRA) and audit (VAA) anchors", async () => {
  const { svc, chain, id } = await run();
  const rec = await svc.verify(id, "{}");
  assert.equal(rec.account, BUYER);
  assert.equal(rec.requestAnchorTx, "aa".repeat(32));
  assert.equal(rec.auditAnchorTx, "bb".repeat(32));
  assert.equal(chain.requests, 1);
  assert.equal(chain.audits, 1);
  assert.ok(svc.status(BUYER));
  assert.equal(svc.status(OTHER), null);
});

test("official check failing (bad ZK proof, unanchored request, inactive credential) is refused", async () => {
  const { svc, id } = await run({ auditFails: "官方驗證未通過：proof invalid" });
  await assert.rejects(svc.verify(id, "{}"), /proof invalid/);
  assert.equal(svc.status(BUYER), null);
});

test("someone else's credential cannot verify my account — and nothing is anchored", async () => {
  const { svc, chain, id } = await run({ owner: OTHER });
  await assert.rejects(svc.verify(id, "{}"), /屬於帳號/);
  assert.equal(chain.audits, 0);
});

test("identity credential (not linked to an account) is refused", async () => {
  const { svc, id } = await run({ kind: "identity" });
  await assert.rejects(svc.verify(id, "{}"), /帳號 credential/);
});

test("more than one credential is refused", async () => {
  const { svc, id } = await run({ count: 2 });
  await assert.rejects(svc.verify(id, "{}"), /一個 credential/);
});

test("request id can only be used once", async () => {
  const { svc, id } = await run();
  await svc.verify(id, "{}");
  await assert.rejects(svc.verify(id, "{}"), /用過/);
});

test("unknown request id is refused", async () => {
  const { svc } = await run();
  await assert.rejects(svc.verify("00".repeat(32), "{}"), /不存在/);
});

test("expired request is refused", async () => {
  let now = 1_000_000;
  const { svc, id } = await run({}, () => now);
  now += CHALLENGE_TTL_MS + 1;
  await assert.rejects(svc.verify(id, "{}"), /過期/);
});

test("weaker statement (younger age bound / fewer restricted countries) is refused", async () => {
  const [age, region] = WANT;
  for (const [statement, msg] of [
    [[{ ...age, upper: "20991231" }, region], /dob/],
    [[age, { ...region, set: ["KP"] }], /US/],
    [[age], /缺少/],
  ] as const) {
    const { svc, id } = await run({ statement: [...statement] as Atomic[] });
    await assert.rejects(svc.verify(id, "{}"), msg);
  }
});

test("unknown identity provider is refused", async () => {
  const { svc, id } = await run({ issuer: 9 });
  await assert.rejects(svc.verify(id, "{}"), /身份提供者/);
});

test("changing the policy invalidates earlier verifications", async () => {
  const store = new EligibilityStore();
  const chain = fakeChain();
  const svc = new EligibilityService(POLICY, store, chain);
  const { id } = await svc.challenge(BUYER);
  await svc.verify(id, "{}");
  const stricter = new EligibilityService({ ...POLICY, restrictedCountries: ["DK", "KP", "US"] }, store, chain);
  assert.equal(stricter.status(BUYER), null);
});

test("requested claims: account credential, age ≥ 18, country not restricted, on-chain issuers", () => {
  const [claim] = buildClaims(POLICY, [0, 3]);
  assert.deepEqual(claim.source, ["accountCredential"]);
  assert.deepEqual(claim.issuers.map((i) => i.index), [0, 3]);
  assert.deepEqual(claim.statements.map((s) => s.type), ["AttributeInRange", "AttributeNotInSet"]);
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

test("prototype keys are never treated as approved accounts", () => {
  const store = new EligibilityStore();
  for (const k of ["__proto__", "constructor", "toString", "hasOwnProperty"]) assert.equal(store.status(k, "any"), null);
});
