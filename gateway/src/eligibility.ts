/**
 * 買方資格驗證（Concordium Verify & Access，官方 V1 協定）
 * -------------------------------------------------------
 * 交易訊號在很多地方屬於受管制的投資資訊，所以 VeriFlow 只賣給：
 *   1. 年滿 18 歲
 *   2. 居住國不在限制名單（RESTRICTED_COUNTRIES，預設 US,KP,IR,CU,SY）
 * 的買方。買方用 Concordium 錢包產生零知識證明，VeriFlow 看不到生日、國家、姓名。
 *
 * 官方 V1 流程（每次驗證在鏈上留下兩筆紀錄）：
 *   POST /eligibility/challenge {account}
 *       → 建立驗證請求（年齡、國家條件 + 一次性 nonce + 綁定買方帳號的說明）
 *       → 請求的雜湊寫上鏈（VRA，Verification Request Anchor），等最終確認
 *   錢包 requestVerifiablePresentationV1(request) → 對「鏈上的那個請求」產生證明
 *   POST /eligibility/verify {id, presentation}
 *       ① id 是我們發的、沒過期、只能用一次
 *       ② 只有一個 credential，而且是帳號 credential（才能對應到付款帳號）
 *       ③ 證明的條件至少跟要求一樣嚴格；簽發者是鏈上登記的身份提供者
 *       ④ credential 屬於這個買方帳號（鏈上查 credential → 帳號）
 *       ⑤ 官方檢查（SDK createChecked）：context 對得上請求、零知識證明成立、
 *          credential 有效、請求確實已上鏈、證明的條件符合請求
 *       ⑥ 全部通過 → 稽核紀錄的雜湊寫上鏈（VAA，Verification Audit Anchor）
 *   → 帳號列入白名單（預設 30 天），附上 VRA 與 VAA 兩筆交易
 *
 * 付款時（x402 onBeforeVerify）：付款交易的 sender 不在白名單 → 拒絕，買方的錢不會被扣。
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  AccountAddress,
  CredentialRegistrationId,
  IdentityProviderDID,
  TransactionHash,
  VerifiableCredentialV1,
  VerifiablePresentationV1,
  VerificationAuditRecordV1,
  VerificationRequestV1,
} from "@concordium/web-sdk";
import { createGrpc } from "./grpc.js";
import { loadAccount } from "./config.js";

export const MIN_AGE = 18;
export const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 分鐘內要完成證明
export const ELIGIBILITY_TTL_MS = 30 * 24 * 3600 * 1000; // 驗證一次有效 30 天
export const CHAIN_TIMEOUT_MS = 60_000; // 上鏈要等最終確認，給寬一點

export type Policy = { minAge: number; restrictedCountries: string[] };

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

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} 逾時（${CHAIN_TIMEOUT_MS / 1000} 秒），請再試一次`)), CHAIN_TIMEOUT_MS)),
  ]);
}

export function parseCountries(s: string | undefined): string[] {
  return (s ?? "US,KP,IR,CU,SY")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter((c) => /^[A-Z]{2}$/.test(c))
    .sort();
}

/** 政策指紋：改了限制名單或年齡，舊的驗證自動失效 */
export function policyId(p: Policy): string {
  return createHash("sha256").update(JSON.stringify({ v: 1, a: p.minAge, r: [...p.restrictedCountries].sort() })).digest("hex").slice(0, 16);
}

/** 要求的條件：帳號 credential（才能對應付款帳號），只接受鏈上登記的身份提供者 */
export function buildClaims(p: Policy, identityProviders: number[]): VerificationRequestV1.SubjectClaims[] {
  return VerificationRequestV1.claimsBuilder()
    .addAccountClaims(
      identityProviders.map((i) => new IdentityProviderDID("Testnet", i)),
      (b) => b.addMinimumAge(p.minAge).addNonMembership("countryOfResidence", p.restrictedCountries),
    )
    .getClaims();
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

export type Atomic = { type: string; attributeTag: string; lower?: unknown; upper?: unknown; set?: unknown[] };

/**
 * 檢查「已證明的條件」至少跟「要求的條件」一樣嚴格。回傳 null = 通過，否則回傳缺什麼。
 * - 年齡：dob 落在 [lower, upper)；證明的 upper 不能比要求的晚（晚 = 可能更年輕）
 * - 地區：證明的「不在名單」集合要包含所有限制國家
 * （SDK 的官方檢查也會比對條件；這裡再檢查一次，錯誤訊息比較清楚）
 */
export function statementGap(want: Atomic[], got: Atomic[]): string | null {
  for (const w of want) {
    const g = got.find((s) => s.type === w.type && s.attributeTag === w.attributeTag);
    if (!g) return `缺少 ${w.type}(${w.attributeTag})`;
    if (w.type === "AttributeInRange" && (g.upper === undefined || w.upper === undefined || String(g.upper) > String(w.upper)))
      return `${w.attributeTag} 範圍太寬（${String(g.upper)} > ${String(w.upper)}）`;
    if (w.type === "AttributeNotInSet") {
      const have = (g.set ?? []).map(String);
      const missing = (w.set ?? []).map(String).filter((x) => !have.includes(x));
      if (missing.length) return `${w.attributeTag} 沒排除 ${missing.join(",")}`;
    }
  }
  return null;
}

/** 從證明裡取出我們要檢查的部分（真實版本由 Chain 解析 SDK 物件） */
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
  verifiedAt: string;
  expiresAt: string;
};

/** 白名單 + 未使用的請求（白名單存成 JSON 檔，重開不會掉） */
export class EligibilityStore {
  private challenges = new Map<string, Challenge>();
  private eligible: Record<string, Eligible> = {};

  constructor(private file?: string, private now: () => number = Date.now) {
    if (file && existsSync(file)) this.eligible = JSON.parse(readFileSync(file, "utf8"));
  }

  put(id: string, c: Omit<Challenge, "expires">) {
    this.challenges.set(id, { ...c, expires: this.now() + CHALLENGE_TTL_MS });
  }

  /** 取出並作廢（只能用一次） */
  take(id: string): Challenge {
    const c = this.challenges.get(id);
    this.challenges.delete(id);
    if (!c) throw new Error("驗證請求不存在或已經用過");
    if (c.expires < this.now()) throw new Error("驗證請求已過期，請重新開始");
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

/** 鏈上依賴（測試時換成假的） */
export type Chain = {
  identityProviders(): Promise<number[]>;
  /** 建立驗證請求並把雜湊寫上鏈（VRA），等到最終確認 */
  anchorRequest(nonce: Uint8Array, id: string, resource: string, note: string, claims: VerificationRequestV1.SubjectClaims[]): Promise<AnchoredRequest>;
  parsePresentation(json: string): ParsedPresentation;
  /** 官方完整檢查，通過才把稽核紀錄寫上鏈（VAA）；不通過丟錯 */
  auditAndAnchor(id: string, request: AnchoredRequest, presentation: ParsedPresentation): Promise<string>;
  accountOfCredential(credId: string): Promise<string>;
};

export function concordiumChain(anchorKeyFile: string): Chain {
  const grpc = createGrpc();
  const anchor = loadAccount(anchorKeyFile);
  const metadata = () => ({ sender: anchor.accountAddress, signer: anchor.signer });
  let ips: number[] | undefined;

  return {
    async identityProviders() {
      if (!ips) {
        ips = [];
        for await (const ip of grpc.getIdentityProviders()) ips.push(ip.ipIdentity);
      }
      return ips;
    },

    async anchorRequest(nonce, id, resource, note, claims) {
      const context = VerificationRequestV1.createSimpleContext(nonce, id, resource, note);
      const request = await VerificationRequestV1.createAndAnchor(grpc, metadata(), context, claims, { service: "veriflow" });
      // 錢包只接受「已最終確認」的請求，所以等它確認完才交給頁面
      await grpc.waitForTransactionFinalization(request.transactionRef);
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
      const r = await VerificationAuditRecordV1.createAndAnchor(
        id,
        req.request as VerificationRequestV1.Type,
        parsed.presentation as VerifiablePresentationV1.Type,
        grpc,
        { metadata: metadata(), info: { service: "veriflow" } },
        { network: "Testnet" },
      );
      if (r.type === "failed") throw new Error(`官方驗證未通過：${r.error.message}`);
      return TransactionHash.toHexString(r.result.anchorTransactionRef);
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

  /** 建立並上鏈一個綁定此帳號的驗證請求 */
  async challenge(account: string) {
    AccountAddress.fromBase58(account); // 格式錯誤會丟錯
    const claims = buildClaims(this.policy, await this.chain.identityProviders());
    const nonce = randomBytes(32);
    const id = nonce.toString("hex");
    const note = `VeriFlow buyer eligibility for ${account}`;
    const request = await withTimeout(this.chain.anchorRequest(nonce, id, this.resource, note, claims), "驗證請求上鏈");
    this.store.put(id, { account, request, wanted: claims[0].statements as Atomic[], policy: this.policyId });
    return { id, request: request.json, requestAnchorTx: request.txHash, policy: this.describe() };
  }

  async verify(id: string, presentationJson: string): Promise<Eligible> {
    const c = this.store.take(id);
    if (c.policy !== this.policyId) throw new Error("政策已更新，請重新開始");

    const parsed = this.chain.parsePresentation(presentationJson);
    if (parsed.credentials.length !== 1) throw new Error("只接受一個 credential 的證明");
    const vc = parsed.credentials[0];
    if (vc.kind !== "account") throw new Error("需要帳號 credential（才能確認是付款帳號本人）");

    const problem = statementGap(c.wanted, vc.statement);
    if (problem) throw new Error(`證明的條件不足：${problem}`);

    const issuer = idpFromDid(vc.issuer);
    if (!(await this.chain.identityProviders()).includes(issuer)) throw new Error(`身份提供者 ${issuer} 不在鏈上名單`);

    const credId = credIdFromDid(vc.id);
    const owner = await withTimeout(this.chain.accountOfCredential(credId), "查詢 credential 所屬帳號");
    if (owner !== c.account) throw new Error(`這個證明屬於帳號 ${owner}，不是 ${c.account}`);

    // 最後才做官方檢查 + 稽核上鏈（要花手續費，前面便宜的檢查先擋掉）
    const auditAnchorTx = await withTimeout(this.chain.auditAndAnchor(id, c.request, parsed), "官方驗證與稽核上鏈");

    return this.store.grant({
      account: c.account,
      credId,
      issuer,
      policy: this.policyId,
      requestAnchorTx: c.request.txHash,
      auditAnchorTx,
    });
  }

  status(account: string) {
    return this.store.status(account, this.policyId);
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
