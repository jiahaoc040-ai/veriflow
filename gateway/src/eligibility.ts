/**
 * Buyer eligibility (Concordium Verify & Access, official V1 protocol)
 * -------------------------------------------------------
 * Trading signals are regulated investment information in many places, so VeriFlow sells only to buyers who are:
 *   1. 18 or older
 *   2. not resident in a restricted country (RESTRICTED_COUNTRIES, default US,KP,IR,CU,SY)
 * The buyer creates a zero-knowledge proof in a Concordium wallet; VeriFlow never sees a birth date, country or name.
 *
 * Official V1 flow (each verification leaves two records on-chain):
 *   POST /eligibility/challenge {account}
 *       → build a verification request (age and country conditions + a one-time nonce + a note binding the buyer account)
 *       → anchor the request's hash on-chain (VRA, Verification Request Anchor) and wait for finalization
 *   wallet requestVerifiablePresentationV1(request) → proves against the request that is on-chain
 *   POST /eligibility/verify {id, presentation}
 *       ① the id is ours, not expired, and single-use
 *       ② exactly one credential, and it is an account credential (so it maps to the paying account)
 *       ③ the proven conditions are at least as strict as requested; the issuer is an identity provider registered on-chain
 *       ④ the credential belongs to this buyer account (credential → account, read from the chain)
 *       ⑤ official check (SDK createChecked): context matches the request, the zero-knowledge proof holds,
 *          the credential is valid, the request is really on-chain, and the proven conditions match the request
 *       ⑥ all pass → anchor the audit record's hash on-chain (VAA, Verification Audit Anchor)
 *   → the account is allow-listed (30 days by default), with the VRA and VAA transactions attached
 *
 * At payment (x402 onBeforeVerify): if the payment's sender is not allow-listed, refuse; the buyer is not charged.
 */
import { pgSsl } from "./once.js";
import { NET } from "./network.js";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  AccountAddress,
  CredentialRegistrationId,
  DataBlob,
  SequenceNumber,
  Transaction,
  TransactionExpiry,
  IdentityProviderDID,
  TransactionHash,
  VerifiableCredentialV1,
  VerifiablePresentationV1,
  VerificationAuditRecordV1,
  VerificationRequestV1,
} from "@concordium/web-sdk";
import { createGrpc } from "./grpc.js";
import { loadAccount } from "./config.js";
import { forgetNonce, pickNonce, serialize, waitForNode } from "./txqueue.js";

export const MIN_AGE = 18;
export const CHALLENGE_TTL_MS = 10 * 60 * 1000; // the proof must be completed within 10 minutes
export const ELIGIBILITY_TTL_MS = 30 * 24 * 3600 * 1000; // one verification is valid for 30 days
export const CHAIN_TIMEOUT_MS = 180_000; // anchoring waits for finalization; testnet sometimes takes a minute or two

export type Policy = { minAge: number; restrictedCountries: string[] };

/**
 * The payer account of an x402 Concordium payment.
 * payload = { signedTransaction: { header: { sender }, signatures: { sender: … } } }
 * The sender is signed by the buyer's key and the facilitator verifies the signature, so another address cannot be claimed.
 */
export function payerOf(payload: unknown): string | undefined {
  const p = payload as { signedTransaction?: { header?: { sender?: unknown } } } | undefined;
  const s = p?.signedTransaction?.header?.sender;
  return typeof s === "string" ? s : undefined;
}

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  // The timer is cleared once p settles, so a finished check leaves nothing running for three minutes
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<T>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${what} timed out (${CHAIN_TIMEOUT_MS / 1000} s); please try again`)), CHAIN_TIMEOUT_MS);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

export function parseCountries(s: string | undefined): string[] {
  return (s ?? "US,KP,IR,CU,SY")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c))
    .sort();
}

/** Policy fingerprint: changing the restricted list or the age invalidates earlier verifications */
export function policyId(p: Policy): string {
  return createHash("sha256").update(JSON.stringify({ v: 1, a: p.minAge, r: [...p.restrictedCountries].sort() })).digest("hex").slice(0, 16);
}

/** Requested conditions: an account credential (so it maps to the paying account), only from identity providers registered on-chain */
export function buildClaims(p: Policy, identityProviders: number[]): VerificationRequestV1.SubjectClaims[] {
  return VerificationRequestV1.claimsBuilder()
    .addAccountClaims(
      identityProviders.map((i) => new IdentityProviderDID(NET.did, i)),
      (b) => b.addMinimumAge(p.minAge).addNonMembership("countryOfResidence", p.restrictedCountries),
    )
    .getClaims();
}

/** did:ccd:testnet:cred:<hex> → <hex> */
export function credIdFromDid(did: string): string {
  const m = /^did:ccd:(testnet|mainnet):cred:([0-9a-f]+)$/.exec(did);
  if (!m) throw new Error(`not an account credential: ${did}`);
  return m[2];
}

/** did:ccd:testnet:idp:<n> → n */
export function idpFromDid(did: string): number {
  const m = /^did:ccd:(testnet|mainnet):idp:(\d+)$/.exec(did);
  if (!m) throw new Error(`not an identity provider: ${did}`);
  return Number(m[2]);
}

export type Atomic = { type: string; attributeTag: string; lower?: unknown; upper?: unknown; set?: unknown[] };

/**
 * Check that the proven conditions are at least as strict as the requested ones. Returns null if they are, otherwise what is missing.
 * - Age: dob in [lower, upper); the proven upper bound may not be later than requested (later = possibly younger)
 * - Region: the proven "not in" set must contain every restricted country
 * (The SDK's official check also compares conditions; checking again here gives clearer error messages.)
 */
export function statementGap(want: Atomic[], got: Atomic[]): string | null {
  for (const w of want) {
    const g = got.find((s) => s.type === w.type && s.attributeTag === w.attributeTag);
    if (!g) return `missing ${w.type}(${w.attributeTag})`;
    if (w.type === "AttributeInRange" && (g.upper === undefined || w.upper === undefined || String(g.upper) > String(w.upper)))
      return `${w.attributeTag} range too wide (${String(g.upper)} > ${String(w.upper)})`;
    if (w.type === "AttributeNotInSet") {
      const have = (g.set ?? []).map(String);
      const missing = (w.set ?? []).map(String).filter((x) => !have.includes(x));
      if (missing.length) return `${w.attributeTag} does not exclude ${missing.join(",")}`;
    }
  }
  return null;
}

/** Extract the parts of a proof we check (the real implementation parses SDK objects in Chain) */
export type ParsedPresentation = {
  presentation: unknown;
  credentials: { kind: "account" | "identity"; id: string; issuer: string; statement: Atomic[] }[];
};

export type AnchoredRequest = { request: unknown; json: unknown; txHash: string };

export type Challenge = { account: string; request: AnchoredRequest; wanted: Atomic[]; expires: number; policy: string };
export type Eligible = {
  account: string;
  credId: string;
  issuer: number;
  policy: string;
  requestAnchorTx: string; // VRA
  auditAnchorTx: string; // VAA
  /** For the re-check at payment: request id, the request itself, the buyer's proof (the proof holds no birth date or country) */
  challengeId?: string;
  requestJson?: unknown;
  presentationJson?: string;
  verifiedAt: string;
  expiresAt: string;
};

/** Where the allow-list lives: a local JSON file, or Postgres when deployed (DATABASE_URL) */
export type Persistence = {
  load(): Promise<Record<string, Eligible>>;
  save(rec: Eligible): Promise<void>;
};

/** Read the JSON file; a missing file counts as empty (read and handle ENOENT instead of check-then-read, so it cannot be swapped in between) */
function readJsonOrEmpty(file: string): Record<string, Eligible> {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
}

export function filePersistence(file: string): Persistence {
  return {
    async load() {
      return readJsonOrEmpty(file);
    },
    async save(rec) {
      const all = readJsonOrEmpty(file);
      all[rec.account] = rec;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(all, null, 2));
    },
  };
}

export function postgresPersistence(url: string): Persistence {
  // Loaded lazily, so local runs without Postgres need no connection
  let pool: import("pg").Pool | undefined;
  const db = async () => {
    if (!pool) {
      const { default: pg } = await import("pg");
      pool = new pg.Pool({ connectionString: url, max: 3, ssl: pgSsl(url) });
      await pool.query("CREATE TABLE IF NOT EXISTS eligibility (account TEXT PRIMARY KEY, record JSONB NOT NULL)");
    }
    return pool;
  };
  return {
    async load() {
      const { rows } = await (await db()).query("SELECT account, record FROM eligibility");
      return Object.fromEntries(rows.map((r: { account: string; record: Eligible }) => [r.account, r.record]));
    },
    async save(rec) {
      await (await db()).query(
        "INSERT INTO eligibility (account, record) VALUES ($1, $2) ON CONFLICT (account) DO UPDATE SET record = EXCLUDED.record",
        [rec.account, JSON.stringify(rec)],
      );
    },
  };
}

/** Allow-list + unused requests (the allow-list is written to Persistence and survives restarts; pending requests stay in memory) */
export class EligibilityStore {
  private challenges = new Map<string, Challenge>();
  private busy = new Set<string>();
  // Object without a prototype: account strings are keys, so "__proto__" and similar cannot pollute it
  private eligible: Record<string, Eligible> = Object.create(null);

  constructor(private persistence?: Persistence, private now: () => number = Date.now) {}

  /** Load the allow-list from storage at startup */
  async init() {
    if (this.persistence) this.eligible = Object.assign(Object.create(null), await this.persistence.load());
    return this;
  }

  put(id: string, c: Omit<Challenge, "expires">) {
    this.challenges.set(id, { ...c, expires: this.now() + CHALLENGE_TTL_MS });
  }

  /** Take and invalidate (single use) */
  take(id: string): Challenge {
    const c = this.claim(id);
    this.finish(id);
    return c;
  }

  /**
   * Start verifying: lock this request (one verification at a time) but do not delete it yet.
   * If verification fails (proof mismatch, node timeout), release it so the user can retry within the window without anchoring a new request;
   * only success deletes it via finish, so one request can never be used twice.
   */
  claim(id: string): Challenge {
    const c = this.challenges.get(id);
    if (!c) throw new Error("verification request not found or already used");
    if (c.expires < this.now()) {
      this.challenges.delete(id);
      throw new Error("verification request expired; please start again");
    }
    if (this.busy.has(id)) throw new Error("this verification request is being processed; please wait");
    this.busy.add(id);
    return c;
  }
  release(id: string) {
    this.busy.delete(id);
  }
  finish(id: string) {
    this.busy.delete(id);
    this.challenges.delete(id);
  }

  async grant(e: Omit<Eligible, "verifiedAt" | "expiresAt">): Promise<Eligible> {
    const t = this.now();
    const rec = { ...e, verifiedAt: new Date(t).toISOString(), expiresAt: new Date(t + ELIGIBILITY_TTL_MS).toISOString() };
    await this.persistence?.save(rec); // write to storage first; it only counts if that succeeds
    this.eligible[e.account] = rec;
    return rec;
  }

  status(account: string, policy: string): Eligible | null {
    const e = this.eligible[account];
    if (!e || e.policy !== policy || !(Date.parse(e.expiresAt) >= this.now())) return null;
    // Old records stored no proof, so they cannot be re-checked at payment: treat as unverified and ask the buyer to verify again
    if (!e.presentationJson || !e.requestJson || !e.challengeId) return null;
    return e;
  }
}

/** On-chain dependencies (replaced by fakes in tests) */
export type Chain = {
  /** fresh = read from the node now (used at payment); otherwise a recent list may be reused */
  identityProviders(fresh?: boolean): Promise<number[]>;
  /** Does this account exist on-chain? (A challenge costs an on-chain anchor, so a made-up address is refused first.) Optional for test chains */
  accountExists?(account: string): Promise<boolean>;
  /** Build a verification request and anchor its hash on-chain (VRA), waiting for finalization */
  anchorRequest(nonce: Uint8Array, id: string, resource: string, note: string, claims: VerificationRequestV1.SubjectClaims[]): Promise<AnchoredRequest>;
  parsePresentation(json: string): ParsedPresentation;
  /** Full official check; only if it passes, anchor the audit record (VAA). Throws otherwise */
  auditAndAnchor(id: string, request: AnchoredRequest, presentation: ParsedPresentation): Promise<string>;
  accountOfCredential(credId: string): Promise<string>;
  /**
   * Re-check at payment (every payment, never cached): re-run the official check on the stored request and proof (zero-knowledge proof, conditions,
   * credential still valid, request still on-chain), and confirm the anchored audit record (VAA) is this record. Throws otherwise.
   */
  recheckAudit(challengeId: string, requestJson: unknown, presentationJson: string, auditAnchorTx: string): Promise<void>;
  /** Register a short record on-chain from the anchoring account (returns the transaction hash once submitted). Optional for test chains */
  registerData?(text: string): Promise<string>;
};

/** The on-chain record of one payment's re-check: which payment, which payer, which audit record (VAA) it was checked against, under which policy */
export function recheckRecord(paymentTx: string, payer: string, auditAnchorTx: string, policy: string): string {
  if (!/^[0-9a-f]{64}$/.test(paymentTx) || !/^[0-9a-f]{64}$/.test(auditAnchorTx)) throw new Error("bad transaction hash");
  if (!/^[1-9A-HJ-NP-Za-km-z]{50}$/.test(payer)) throw new Error("bad account");
  return `veriflow:recheck:v1:${paymentTx}:${payer}:${auditAnchorTx}:${policy}`;
}

/** gRPC status NOT_FOUND only, by its code (the SDK's RpcError carries "NOT_FOUND" or 5), never a message that merely says "not found" */
export function isGrpcNotFound(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "NOT_FOUND" || code === 5;
}

export function concordiumChain(anchorKeyFile: string): Chain {
  const grpc = createGrpc();
  const anchor = loadAccount(anchorKeyFile);
  const metadata = () => ({ sender: anchor.accountAddress, signer: anchor.signer });
  const nodeNonce = async () => (await grpc.getNextAccountNonce(anchor.accountAddress)).nonce.value;
  let ips: number[] | undefined;
  let ipsAt = 0;

  return {
    async accountExists(account) {
      try {
        await grpc.getAccountInfo(AccountAddress.fromBase58(account));
        return true;
      } catch (e) {
        // gRPC NOT_FOUND (status 5) = no such account; anything else (node down, UNIMPLEMENTED…) is thrown so the caller does not anchor blindly
        if (isGrpcNotFound(e)) return false;
        throw e;
      }
    },

    async identityProviders(fresh = false) {
      // fresh (at payment): read the list now, and an empty list refuses. Otherwise (challenge): a non-empty list cached for an hour
      if (fresh) {
        const now: number[] = [];
        for await (const ip of grpc.getIdentityProviders()) now.push(ip.ipIdentity);
        if (!now.length) throw new Error("the node returned no identity provider list");
        ips = now;
        ipsAt = Date.now();
        return now;
      }
      if (!ips || Date.now() - ipsAt > 3_600_000) {
        const fresh: number[] = [];
        for await (const ip of grpc.getIdentityProviders()) fresh.push(ip.ipIdentity);
        if (fresh.length) {
          ips = fresh;
          ipsAt = Date.now();
        } else if (!ips) throw new Error("the node returned no identity provider list; please try again later");
      }
      return ips;
    },

    async anchorRequest(nonce, id, resource, note, claims) {
      const context = VerificationRequestV1.createSimpleContext(nonce, id, resource, note);
      // The SDK picks its own nonce: queue the whole step and wait for finalization before the next one, so nonces never collide (see txqueue.ts)
      // The wallet also accepts only finalized requests
      const request = await serialize(anchor.address, async () => {
        await waitForNode(anchor.address, nodeNonce);
        const r = await VerificationRequestV1.createAndAnchor(grpc, metadata(), context, claims, { service: "veriflow" });
        await grpc.waitForTransactionFinalization(r.transactionRef);
        return r;
      });
      return { request, json: request.toJSON(), txHash: TransactionHash.toHexString(request.transactionRef) };
    },

    parsePresentation(json) {
      const presentation = VerifiablePresentationV1.fromJSON(JSON.parse(json));
      return {
        presentation,
        credentials: presentation.verifiableCredential.map((vc) => ({
          kind: VerifiableCredentialV1.isAccountCredential(vc) ? ("account" as const) : ("identity" as const),
          id: vc.credentialSubject.id,
          issuer: vc.issuer,
          statement: vc.credentialSubject.statement as Atomic[],
        })),
      };
    },

    async auditAndAnchor(id, req, parsed) {
      const r = await serialize(anchor.address, async () => {
        await waitForNode(anchor.address, nodeNonce);
        const out = await VerificationAuditRecordV1.createAndAnchor(
          id,
          req.request as VerificationRequestV1.Type,
          parsed.presentation as VerifiablePresentationV1.Type,
          grpc,
          { metadata: metadata(), info: { service: "veriflow" } },
          { network: NET.did },
        );
        if (out.type !== "failed") await grpc.waitForTransactionFinalization(out.result.anchorTransactionRef);
        return out;
      });
      if (r.type === "failed") throw new Error(`official verification failed: ${r.error.message}`);
      return TransactionHash.toHexString(r.result.anchorTransactionRef);
    },

    async registerData(text) {
      const data = new TextEncoder().encode(text);
      if (data.length > 256) throw new Error("record longer than 256 bytes");
      return serialize(anchor.address, async () => {
        const fromNode = await nodeNonce();
        const tx = Transaction.registerData({ data: new DataBlob(data.buffer as ArrayBuffer) })
          .addMetadata({ sender: anchor.accountAddress, nonce: SequenceNumber.create(pickNonce(anchor.address, fromNode)), expiry: TransactionExpiry.futureMinutes(5) })
          .build();
        try {
          return TransactionHash.toHexString(await grpc.sendTransaction(await Transaction.signAndFinalize(tx, anchor.signer)));
        } catch (e) {
          forgetNonce(anchor.address);
          throw e;
        }
      });
    },

    async recheckAudit(challengeId, requestJson, presentationJson, auditAnchorTx) {
      const request = VerificationRequestV1.fromJSON(requestJson as VerificationRequestV1.JSON);
      const presentation = VerifiablePresentationV1.fromJSON(JSON.parse(presentationJson));
      const r = await VerificationAuditRecordV1.createChecked(challengeId, request, presentation, grpc, NET.did);
      if (r.type === "failed") throw new Error(`proof no longer passes the official check: ${r.error.message}`);
      // The SDK's verifyAnchor hashes without info; we anchor with { service: "veriflow" }, so compare the whole anchor ourselves
      const expected = Buffer.from(VerificationAuditRecordV1.createAnchor(r.result, { service: "veriflow" })).toString("hex");
      // Both the request (VRA) and the audit record (VAA) must be sent by our anchoring account: anchors someone else made do not count
      const sentByUs = async (tx: string, what: string) => {
        const st = await grpc.getBlockItemStatus(TransactionHash.fromHexString(tx));
        if (st.status !== "finalized") throw new Error(`${what} transaction is not finalized`);
        const s = st.outcome.summary as { sender?: AccountAddress.Type; dataRegistered?: { data?: string } };
        if (!s.sender || AccountAddress.toBase58(s.sender) !== anchor.address) throw new Error(`${what} was not anchored by VeriFlow's account`);
        return s;
      };
      const vra = (request as unknown as { transactionRef: TransactionHash.Type }).transactionRef;
      await sentByUs(TransactionHash.toHexString(vra), "verification request");
      const data = (await sentByUs(auditAnchorTx, "audit record")).dataRegistered?.data;
      if (!data || data.toLowerCase() !== expected) throw new Error("the audit record on-chain is not this proof's record");
    },

    async accountOfCredential(credId) {
      const info = await grpc.getAccountInfo(CredentialRegistrationId.fromHexString(credId));
      return AccountAddress.toBase58(info.accountAddress);
    },
  };
}

export class EligibilityService {
  readonly policyId: string;

  constructor(
    readonly policy: Policy,
    private store: EligibilityStore,
    private chain: Chain,
    private resource = "veriflow",
  ) {
    this.policyId = policyId(policy);
  }

  /** Build and anchor a verification request bound to this account */
  async challenge(account: string) {
    AccountAddress.fromBase58(account); // throws on a malformed address
    if (this.chain.accountExists && !(await withTimeout(this.chain.accountExists(account), "looking up the account")))
      throw new Error("no such account on this network: create it in the Concordium wallet first");
    const claims = buildClaims(this.policy, await this.chain.identityProviders());
    const nonce = randomBytes(32);
    const id = nonce.toString("hex");
    const note = `VeriFlow buyer eligibility for ${account}`;
    const request = await withTimeout(this.chain.anchorRequest(nonce, id, this.resource, note, claims), "anchoring the verification request");
    this.store.put(id, { account, request, wanted: claims[0].statements as Atomic[], policy: this.policyId });
    return { id, request: request.json, requestAnchorTx: request.txHash, policy: this.describe() };
  }

  async verify(id: string, presentationJson: string): Promise<Eligible> {
    const c = this.store.claim(id);
    try {
      const rec = await this.verifyClaimed(id, c, presentationJson);
      this.store.finish(id);
      return rec;
    } catch (e) {
      this.store.release(id);
      throw e;
    }
  }

  private async verifyClaimed(id: string, c: Challenge, presentationJson: string): Promise<Eligible> {
    if (c.policy !== this.policyId) throw new Error("the policy has changed; please start again");

    const parsed = this.chain.parsePresentation(presentationJson);
    if (parsed.credentials.length !== 1) throw new Error("only proofs with exactly one credential are accepted");
    const vc = parsed.credentials[0];
    if (vc.kind !== "account") throw new Error("an account credential is required (to confirm it is the paying account)");

    const problem = statementGap(c.wanted, vc.statement);
    if (problem) throw new Error(`the proven conditions are not enough: ${problem}`);

    const issuer = idpFromDid(vc.issuer);
    if (!(await this.chain.identityProviders()).includes(issuer)) throw new Error(`identity provider ${issuer} is not on the on-chain list`);

    const credId = credIdFromDid(vc.id);
    const owner = await withTimeout(this.chain.accountOfCredential(credId), "looking up the credential's account");
    if (owner !== c.account) throw new Error(`this proof belongs to account ${owner}, not ${c.account}`);

    // The official check and audit anchor come last (they cost a fee); the cheap checks above filter first
    const auditAnchorTx = await withTimeout(this.chain.auditAndAnchor(id, c.request, parsed), "official verification and audit anchoring");

    return await this.store.grant({
      account: c.account,
      credId,
      issuer,
      policy: this.policyId,
      requestAnchorTx: c.request.txHash,
      auditAnchorTx,
      challengeId: id,
      requestJson: c.request.json,
      presentationJson,
    });
  }

  /**
   * Eligibility check at payment (every payment, never cached, any error refuses):
   * 1. a valid record with a stored proof (old records without a proof → verify again)
   * 2. the official check re-run: the proof still holds, the credential is still valid, the request is still on-chain, and the VAA anchors this record
   * 3. the proof's account credential still belongs to this payment's sender
   */
  async recheck(sender: string): Promise<Eligible> {
    const rec = this.status(sender);
    if (!rec) throw new Error("no stored, current proof for this account");
    const parsed = this.chain.parsePresentation(rec.presentationJson!);
    const vc = parsed.credentials[0];
    if (parsed.credentials.length !== 1 || vc.kind !== "account") throw new Error("stored proof is not one account credential");
    // The stored proof must satisfy the current policy and identity provider list (not just the stored policy string)
    // The list as it is now: an issuer removed from the chain's list stops passing at the next payment
    const ips = await withTimeout(this.chain.identityProviders(true), "reading the identity provider list");
    const gap = statementGap(buildClaims(this.policy, ips)[0].statements as Atomic[], vc.statement);
    if (gap) throw new Error(`stored proof does not meet the current policy: ${gap}`);
    if (!ips.includes(idpFromDid(vc.issuer))) throw new Error("stored proof's identity provider is not on the chain's list");
    await withTimeout(this.chain.recheckAudit(rec.challengeId!, rec.requestJson, rec.presentationJson!, rec.auditAnchorTx), "re-check at payment");
    const owner = await withTimeout(this.chain.accountOfCredential(credIdFromDid(vc.id)), "looking up the credential's account");
    if (owner !== sender) throw new Error(`the proof's credential belongs to ${owner}, not the paying account`);
    return rec;
  }

  status(account: string) {
    return this.store.status(account, this.policyId);
  }

  /**
   * After a settled payment whose payer passed the re-check: put that fact on-chain the same day, so the proof record and the payment
   * can be matched by anyone (payment tx, payer, the VAA checked against, policy). Returns the record's transaction, or null if not eligible
   */
  async anchorRecheck(paymentTx: string, payer: string): Promise<{ tx: string; data: string } | null> {
    const rec = this.status(payer);
    if (!rec || !this.chain.registerData) return null;
    const data = recheckRecord(paymentTx, payer, rec.auditAnchorTx, this.policyId);
    return { tx: await this.chain.registerData(data), data };
  }

  describe() {
    return {
      id: this.policyId,
      protocol: "Concordium Verify & Access V1 (request + audit anchored on-chain)",
      minAge: this.policy.minAge,
      restrictedCountries: this.policy.restrictedCountries,
      revealed: "nothing — zero-knowledge proof that the conditions hold",
    };
  }
}
