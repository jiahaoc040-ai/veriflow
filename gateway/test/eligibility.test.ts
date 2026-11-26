/**
 * Eligibility (V1) rule tests: the on-chain part is replaced by a fake Chain, no network needed
 * Run: npm test
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

const BUYER = "2xBpaHottqhwFZURMZW4uZduQvpxNDSy46iXMYs9kceNGaPpZX"; // test address (32 bytes of 0x01)
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
  recheckFails?: string;
};

/** Fake chain: records whether the audit was anchored */
function fakeChain(o: Opts = {}): Chain & { audits: number; requests: number; rechecks: number } {
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
    rechecks: 0,
    async recheckAudit(id: string, _req: unknown, pres: string, vaa: string) {
      chain.rechecks++;
      if (o.recheckFails) throw new Error(o.recheckFails);
      if (!id || !pres || vaa !== "bb".repeat(32)) throw new Error("bad stored proof");
    },
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
  const { svc, id } = await run({ auditFails: "official verification failed: proof invalid" });
  await assert.rejects(svc.verify(id, "{}"), /proof invalid/);
  assert.equal(svc.status(BUYER), null);
});

test("someone else's credential cannot verify my account — and nothing is anchored", async () => {
  const { svc, chain, id } = await run({ owner: OTHER });
  await assert.rejects(svc.verify(id, "{}"), /belongs to account/);
  assert.equal(chain.audits, 0);
});

test("identity credential (not linked to an account) is refused", async () => {
  const { svc, id } = await run({ kind: "identity" });
  await assert.rejects(svc.verify(id, "{}"), /account credential/);
});

test("more than one credential is refused", async () => {
  const { svc, id } = await run({ count: 2 });
  await assert.rejects(svc.verify(id, "{}"), /exactly one credential/);
});

test("request id can only be used once", async () => {
  const { svc, id } = await run();
  await svc.verify(id, "{}");
  await assert.rejects(svc.verify(id, "{}"), /already used/);
});

test("a failed attempt does not burn the request: the buyer can retry with a correct proof", async () => {
  const chain = fakeChain({ kind: "identity" });
  const svc = new EligibilityService(POLICY, new EligibilityStore(), chain);
  const { id } = await svc.challenge(BUYER);
  await assert.rejects(svc.verify(id, "{}"), /account credential/); // wrong credential kind
  (chain as any).parsePresentation = fakeChain({}).parsePresentation; // the buyer retries with an account credential
  const rec = await svc.verify(id, "{}");
  assert.equal(rec.account, BUYER);
  assert.equal((chain as any).requests, 1); // no second request anchored
  await assert.rejects(svc.verify(id, "{}"), /already used/); // and after success it is spent
});

test("two verifications of one request cannot run at the same time", async () => {
  const store = new EligibilityStore();
  store.put("x", { account: BUYER, request: {} as any, wanted: [], policy: "p" });
  store.claim("x");
  assert.throws(() => store.claim("x"), /being processed/);
  store.release("x");
  store.claim("x");
  store.finish("x");
  assert.throws(() => store.claim("x"), /already used/);
});

test("unknown request id is refused", async () => {
  const { svc } = await run();
  await assert.rejects(svc.verify("00".repeat(32), "{}"), /not found/);
});

test("expired request is refused", async () => {
  let now = 1_000_000;
  const { svc, id } = await run({}, () => now);
  now += CHALLENGE_TTL_MS + 1;
  await assert.rejects(svc.verify(id, "{}"), /expired/);
});

test("weaker statement (younger age bound / fewer restricted countries) is refused", async () => {
  const [age, region] = WANT;
  for (const [statement, msg] of [
    [[{ ...age, upper: "20991231" }, region], /dob/],
    [[age, { ...region, set: ["KP"] }], /US/],
    [[age], /missing/],
  ] as const) {
    const { svc, id } = await run({ statement: [...statement] as Atomic[] });
    await assert.rejects(svc.verify(id, "{}"), msg);
  }
});

test("unknown identity provider is refused", async () => {
  const { svc, id } = await run({ issuer: 9 });
  await assert.rejects(svc.verify(id, "{}"), /identity provider/);
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


// ── Re-check at payment ──
test("settlement re-checks the stored proof on every payment, and never caches a pass", async () => {
  const { svc, chain, id } = await run();
  await svc.verify(id, '{"proof":1}');
  await svc.recheck(BUYER);
  await svc.recheck(BUYER);
  assert.equal(chain.rechecks, 2);
});

test("settlement refuses: no proof, a failing re-check, or a credential now owned by another account", async () => {
  const { svc: none } = await run();
  await assert.rejects(none.recheck(BUYER), /no stored/);

  const failing = await run({ recheckFails: "credential revoked" });
  await failing.svc.verify(failing.id, "{}");
  await assert.rejects(failing.svc.recheck(BUYER), /revoked/);

  const moved = await run();
  await moved.svc.verify(moved.id, "{}");
  (moved.chain as any).accountOfCredential = async () => OTHER; // the credential now resolves to a different account
  await assert.rejects(moved.svc.recheck(BUYER), /belongs to/);
});

test("rows written before proofs were stored are not eligible: the buyer must verify again", async () => {
  const store = new EligibilityStore();
  const chain = fakeChain();
  const svc = new EligibilityService(POLICY, store, chain);
  await store.grant({ account: BUYER, credId: "ab12", issuer: 0, policy: svc.policyId, requestAnchorTx: "aa".repeat(32), auditAnchorTx: "bb".repeat(32) });
  assert.equal(svc.status(BUYER), null);
  await assert.rejects(svc.recheck(BUYER), /no stored/);
});

test("settlement checks the stored proof against the current policy, not the stored policy string", async () => {
  const { svc, chain, id } = await run();
  await svc.verify(id, "{}");
  const weaker = WANT.slice(0, 1); // e.g. only the age statement, no residence statement
  const parse = chain.parsePresentation.bind(chain);
  (chain as any).parsePresentation = (j: string) => {
    const p = parse(j);
    return { ...p, credentials: p.credentials.map((c) => ({ ...c, statement: weaker })) };
  };
  await assert.rejects(svc.recheck(BUYER), /current policy/);
});

test("challenge: an account that does not exist on-chain is refused before anything is anchored", async () => {
  const chain = fakeChain();
  const svc = new EligibilityService(POLICY, new EligibilityStore(), { ...chain, accountExists: async () => false });
  await assert.rejects(svc.challenge(BUYER), /no such account/);
  assert.equal(chain.requests, 0);
});
