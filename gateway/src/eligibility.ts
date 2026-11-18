/**
 * 買方資格驗證（Concordium Verify & Access，零知識證明）
 * ----------------------------------------------------
 * 交易訊號在很多地方屬於受管制的投資資訊，所以 VeriFlow 只賣給：
 *   1. 年滿 18 歲
 *   2. 居住國不在限制名單（RESTRICTED_COUNTRIES，預設 US,KP,IR,CU,SY）
 * 的買方。買方用 Concordium Browser Wallet 產生零知識證明，
 * VeriFlow 只知道「條件成立」，看不到生日、國家、姓名。
 *
 * 流程：
 *   POST /eligibility/challenge {account}       → 拿到 challenge + 要證明的 statements
 *   錢包 requestVerifiablePresentation(challenge, statements) → presentation
 *   POST /eligibility/verify {challenge, presentation}
 *       ① 鏈上查 credential 狀態與公開承諾（getPublicData）
 *       ② 驗證零知識證明（verifyPresentation）
 *       ③ challenge 要是我們發的、沒過期、只能用一次（防重放）
 *       ④ 證明的 statements 要跟我們要求的完全一樣（防止只證明比較弱的條件）
 *       ⑤ 簽發者要是鏈上登記的身份提供者
 *       ⑥ 證明用的 credential 要屬於這個買方帳號（鏈上查 credential → 帳號）
 *   全部通過 → 帳號列入白名單（預設 30 天）
 *
 * 付款時（x402 onBeforeVerify）：付款交易的 sender 不在白名單 → 拒絕，買方的錢不會被扣。
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  AccountAddress,
  CredentialRegistrationId,
  VerifiablePresentation,
  Web3StatementBuilder,
  getPublicData,
  verifyPresentation,
  type CredentialStatements,
} from "@concordium/web-sdk";
import { ConcordiumGRPCNodeClient, credentials } from "@concordium/web-sdk/nodejs";
import { getConcordiumGrpcUrl, parseGrpcUrl } from "@x402/concordium";
import { NETWORK } from "./config.js";

export const MIN_AGE = 18;
export const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 分鐘內要完成證明
export const ELIGIBILITY_TTL_MS = 30 * 24 * 3600 * 1000; // 驗證一次有效 30 天

/**
 * x402 Concordium 付款裡的付款人帳號。
 * payload = { signedTransaction: { header: { sender }, signatures: { sender: … } } }
 * sender 由買方的金鑰簽名，facilitator 會驗簽，所以不能冒用別人的地址。
 */
export function payerOf(payload: unknown): string | undefined {
  const p = payload as { signedTransaction?: { header?: { sender?: unknown } } } | undefined;
  const s = p?.signedTransaction?.header?.sender;
  return typeof s === "string" ? s : undefined;
}

/** 鏈上查詢最多等這麼久，避免頁面一直卡在「Verifying…」 */
export const CHAIN_TIMEOUT_MS = 30_000;
function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} 逾時（${CHAIN_TIMEOUT_MS / 1000} 秒），請再試一次`)), CHAIN_TIMEOUT_MS)),
  ]);
}

export type Policy = { minAge: number; restrictedCountries: string[] };

export function parseCountries(s: string | undefined): string[] {
  return (s ?? "US,KP,IR,CU,SY")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c))
    .sort();
}

/** 政策指紋：改了限制名單或年齡，舊的驗證自動失效 */
export function policyId(p: Policy): string {
  return createHash("sha256").update(JSON.stringify({ a: p.minAge, r: [...p.restrictedCountries].sort() })).digest("hex").slice(0, 16);
}

/** 要求錢包證明的條件（只接受鏈上登記的身份提供者簽發的身份） */
export function buildStatements(p: Policy, identityProviders: number[]): CredentialStatements {
  return new Web3StatementBuilder()
    .addForIdentityCredentials(identityProviders, (b) =>
      b.addMinimumAge(p.minAge).addNonMembership("countryOfResidence", p.restrictedCountries),
    )
    .getStatements();
}

/** did:ccd:testnet:cred:<hex> → <hex> */
export function credIdFromDid(did: string): string {
  const m = /^did:ccd:(testnet|mainnet):cred:([0-9a-f]+)$/.exec(did);
  if (!m) throw new Error(`不是帳號 credential：${did}`);
  return m[2];
}

/** did:ccd:testnet:idp:<n> → n */
export function idpFromDid(did: string): number {
  const m = /^did:ccd:(testnet|mainnet):idp:(\d+)$/.exec(did);
  if (!m) throw new Error(`不是身份提供者：${did}`);
  return Number(m[2]);
}

type Atomic = { type: string; attributeTag: string; lower?: string; upper?: string; set?: string[] };

/**
 * 檢查「已證明的條件」至少跟「要求的條件」一樣嚴格。回傳 null = 通過，否則回傳缺什麼。
 * - 年齡：dob 落在 [lower, upper)；證明的 upper 不能比要求的晚（晚 = 可能更年輕）
 * - 地區：證明的「不在名單」集合要包含所有限制國家
 */
export function statementGap(want: Atomic[], got: Atomic[]): string | null {
  for (const w of want) {
    const g = got.find((s) => s.type === w.type && s.attributeTag === w.attributeTag);
    if (!g) return `缺少 ${w.type}(${w.attributeTag})`;
    if (w.type === "AttributeInRange" && (!g.upper || !w.upper || g.upper > w.upper))
      return `${w.attributeTag} 範圍太寬（${g.upper} > ${w.upper}）`;
    if (w.type === "AttributeNotInSet") {
      const missing = (w.set ?? []).filter((x) => !(g.set ?? []).includes(x));
      if (missing.length) return `${w.attributeTag} 沒排除 ${missing.join(",")}`;
    }
  }
  return null;
}

export type Challenge = { account: string; statements: CredentialStatements; expires: number; policy: string };
export type Eligible = { account: string; credId: string; issuer: number; policy: string; verifiedAt: string; expiresAt: string };

/** 白名單 + 未使用的 challenge（白名單存成 JSON 檔，重開不會掉） */
export class EligibilityStore {
  private challenges = new Map<string, Challenge>();
  private eligible: Record<string, Eligible> = {};

  constructor(private file?: string, private now: () => number = Date.now) {
    if (file && existsSync(file)) this.eligible = JSON.parse(readFileSync(file, "utf8"));
  }

  issue(account: string, statements: CredentialStatements, policy: string): string {
    const challenge = randomBytes(32).toString("hex");
    this.challenges.set(challenge, { account, statements, policy, expires: this.now() + CHALLENGE_TTL_MS });
    return challenge;
  }

  /** 取出並作廢（只能用一次） */
  take(challenge: string): Challenge {
    const c = this.challenges.get(challenge);
    this.challenges.delete(challenge);
    if (!c) throw new Error("challenge 不存在或已經用過");
    if (c.expires < this.now()) throw new Error("challenge 已過期，請重新開始");
    return c;
  }

  grant(e: Omit<Eligible, "verifiedAt" | "expiresAt">): Eligible {
    const t = this.now();
    const rec = { ...e, verifiedAt: new Date(t).toISOString(), expiresAt: new Date(t + ELIGIBILITY_TTL_MS).toISOString() };
    this.eligible[e.account] = rec;
    this.save();
    return rec;
  }

  status(account: string, policy: string): Eligible | null {
    const e = this.eligible[account];
    if (!e || e.policy !== policy || Date.parse(e.expiresAt) < this.now()) return null;
    return e;
  }

  private save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.eligible, null, 2));
  }
}

/** 鏈上依賴（測試時可以換成假的） */
export type Chain = {
  identityProviders(): Promise<number[]>;
  /** 驗證 presentation，回傳 verifyPresentation 還原的 request，以及每個 credential 的狀態 */
  verify(p: VerifiablePresentation): Promise<{ challenge: string; credentialStatements: { id: string; statement: unknown }[] }>;
  accountOfCredential(credId: string): Promise<string>;
};

export function concordiumChain(): Chain {
  const [host, port] = parseGrpcUrl(getConcordiumGrpcUrl(NETWORK));
  const grpc = new ConcordiumGRPCNodeClient(host, port, credentials.createSsl());
  let ips: number[] | undefined;
  return {
    async identityProviders() {
      if (!ips) {
        ips = [];
        for await (const ip of grpc.getIdentityProviders()) ips.push(ip.ipIdentity);
      }
      return ips;
    },
    async verify(p) {
      const publicData = await getPublicData(grpc, "Testnet", p);
      // CIS4.CredentialStatus.Active = 0
      const inactive = publicData.findIndex((d) => d.status !== 0);
      if (inactive >= 0) throw new Error(`credential 不是有效狀態（status=${publicData[inactive].status}）`);
      const globalContext = await grpc.getCryptographicParameters();
      return verifyPresentation(p, globalContext, publicData.map((d) => d.inputs)); // 證明不成立會丟錯
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
  ) {
    this.policyId = policyId(policy);
  }

  async challenge(account: string) {
    AccountAddress.fromBase58(account); // 格式錯誤會丟錯
    const statements = buildStatements(this.policy, await this.chain.identityProviders());
    const challenge = this.store.issue(account, statements, this.policyId);
    return { challenge, statements, policy: this.describe() };
  }

  async verify(challenge: string, presentationJson: string): Promise<Eligible> {
    const c = this.store.take(challenge);
    if (c.policy !== this.policyId) throw new Error("政策已更新，請重新開始");
    const presentation = VerifiablePresentation.fromString(presentationJson);
    if (presentation.verifiableCredential.length !== 1) throw new Error("只接受一個 credential 的證明");

    const request = await withTimeout(this.chain.verify(presentation), "Concordium 節點驗證證明");
    if (request.challenge !== challenge) throw new Error("證明綁定的 challenge 不對（可能是重放別人的證明）");

    const want = (c.statements[0] as { statement: Atomic[] }).statement;
    const got = request.credentialStatements[0]?.statement as Atomic[] | undefined;
    const problem = statementGap(want, got ?? []);
    if (problem) throw new Error(`證明的條件不足：${problem}`);

    const vc = presentation.verifiableCredential[0];
    const issuer = idpFromDid(vc.issuer);
    if (!(await this.chain.identityProviders()).includes(issuer)) throw new Error(`身份提供者 ${issuer} 不在鏈上名單`);

    const credId = credIdFromDid(vc.credentialSubject.id);
    const owner = await withTimeout(this.chain.accountOfCredential(credId), "查詢 credential 所屬帳號");
    if (owner !== c.account) throw new Error(`這個證明屬於帳號 ${owner}，不是 ${c.account}`);

    return this.store.grant({ account: c.account, credId, issuer, policy: this.policyId });
  }

  status(account: string) {
    return this.store.status(account, this.policyId);
  }

  describe() {
    return {
      id: this.policyId,
      minAge: this.policy.minAge,
      restrictedCountries: this.policy.restrictedCountries,
      revealed: "nothing — zero-knowledge proof that the conditions hold",
    };
  }
}
