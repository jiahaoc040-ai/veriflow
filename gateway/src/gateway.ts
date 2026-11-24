/**
 * VeriFlow x402 付款關卡
 * ---------------------
 * GET /signal/:asset 要先付款（x402，Concordium testnet CCD）。
 * 付款驗證通過後，帶著共用密鑰轉發到 Python API；Python API 只認這把密鑰，
 * 所以沒付款的人沒辦法繞過關卡直接拿訊號。
 *
 * 公開端點（/track-record、/commitments、/health）直接轉發，不收費。
 *
 * 買方資格：付款前，買方帳號要先在 /verify 用 Concordium 錢包做零知識證明
 * （年滿 18、居住國不在限制名單）。沒驗證的帳號付款會被拒絕，錢不會被扣。
 *
 * 執行：npm run gateway   （預設 http://localhost:4020）
 */
import { AGENT_REGISTRY, readAgent } from "./registry-node.js";
import { AGENT_EXTENSION } from "./counterparty.js";
import { NET, checkGenesis } from "./network.js";
import { createGrpc } from "./grpc.js";
import { BlockHash } from "@concordium/web-sdk";
import express from "express";
import { rateLimit as baselineLimit } from "express-rate-limit";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactConcordiumScheme } from "@x402/concordium/exact/server";
import { GATEWAY_DIR, NETWORK, env } from "./config.js";
import { resolve } from "node:path";
import { createAnchorer } from "./anchor.js";
import { startDailySignals } from "./daily.js";
import { mountRemoteMcp } from "./mcp-http.js";
import { mountA2A } from "./a2a.js";
import { RateLimiter, inlineScriptHashes, rateLimit, securityHeaders } from "./security.js";
import { paidOnChain } from "./settle-recovery.js";
import { BUYER_AGENT_HEADER, checkBuyerAgent, parsePolicy, type BuyerAgentResult } from "./buyer-agent.js";
import { EligibilityService, EligibilityStore, filePersistence, postgresPersistence, MIN_AGE, concordiumChain, parseCountries, payerOf } from "./eligibility.js";

const API_URL = env("API_URL", "http://127.0.0.1:8000");
const GATEWAY_SECRET = env("GATEWAY_SECRET");
const AGENT_BADGE = env("AGENT_BADGE", "JyP9UWYKh54TD2MUJDfqC");
const AGENT_TOKEN_ID = env("AGENT_TOKEN_ID", "1313");
const PAY_TO = env("SELLER_ADDRESS");
const PRICE_MICROCCD = env("PRICE_MICROCCD", "1000000"); // 1 CCD
// 選填：同一個訊號也可以用 Protocol-Level Token 付款，例如 PLT_PRICE=VFUSD:1000000（1 VFUSD，6 位小數）
// 買方從 402 的 accepts 裡挑自己的花費護欄允許的那一種
const PLT_PRICE = (() => {
  const v = (process.env.PLT_PRICE ?? "").trim();
  if (!v) return undefined;
  const m = /^([A-Za-z][A-Za-z0-9-]{1,10}[A-Za-z0-9]):(\d{1,20})$/.exec(v);
  if (!m) throw new Error("PLT_PRICE must look like VFUSD:1000000 (token id and amount in the token's smallest unit)");
  return { asset: m[1], amount: m[2] };
})();

const PUBLIC_URL = env("PUBLIC_URL", "http://localhost:4020");

const eligibility = new EligibilityService(
  { minAge: MIN_AGE, restrictedCountries: parseCountries(process.env.RESTRICTED_COUNTRIES) },
  // 部署時設 DATABASE_URL（Postgres），本機預設 JSON 檔
  await new EligibilityStore(
    process.env.DATABASE_URL
      ? postgresPersistence(process.env.DATABASE_URL)
      : filePersistence(resolve(GATEWAY_DIR, env("ELIGIBILITY_FILE", "data/eligibility.json"))),
  ).init(),
  // 驗證請求（VRA）與稽核紀錄（VAA）由上鏈帳號付手續費寫上鏈
  concordiumChain(env("ANCHOR_KEY_FILE", env("FACILITATOR_KEY_FILE"))),
  PUBLIC_URL,
);
const REQUIRE_ELIGIBILITY = env("REQUIRE_ELIGIBILITY", "true") !== "false";
const BUYER_AGENT_POLICY = parsePolicy(process.env.BUYER_AGENT);
// 測試用的假鏈上紀錄只給買方的整合測試用；賣方伺服器看到它就拒絕啟動，免得驗證被繞過
if (process.env.VERIFLOW_TEST_AGENT_RECORD) {
  console.error("❌ VERIFLOW_TEST_AGENT_RECORD is set; it replaces registry reads and must never be set on the gateway");
  process.exit(1);
}

// 免費主機只有 512 MB：EMBED_FACILITATOR=1 時 facilitator 跑在同一個 Node 程序裡（省約 130 MB）。
// 必須在建立付款中介層「之前」啟動並等它開始監聽，否則中介層啟動時查詢 /supported 會失敗。
if (process.env.EMBED_FACILITATOR) await (await import("./facilitator.js")).listening;

const resourceServer = new x402ResourceServer(
  new HTTPFacilitatorClient({
    url: env("FACILITATOR_URL", "http://localhost:4021"),
    // Concordium 的官方測試網 facilitator 要 API key。金鑰只放環境變數，不進 repo、不進日誌
    ...(process.env.FACILITATOR_API_KEY
      ? {
          createAuthHeaders: async () => {
            const name = process.env.FACILITATOR_AUTH_HEADER || "Authorization";
            const scheme = process.env.FACILITATOR_AUTH_SCHEME ?? (name.toLowerCase() === "authorization" ? "Bearer" : "");
            const h = { [name]: scheme ? `${scheme} ${process.env.FACILITATOR_API_KEY}` : String(process.env.FACILITATOR_API_KEY) };
            return { verify: h, settle: h, supported: h };
          },
        }
      : {}),
  }),
)
  .register(NETWORK, new ExactConcordiumScheme())
  // 付款交易送去結算之前：sender 沒通過資格驗證 → 拒絕（交易不會上鏈，買方不會被扣款）
  .onBeforeVerify(async ({ paymentPayload, transportContext }) => {
    const sender = payerOf(paymentPayload.payload);
    // 雙向驗證：買方若在標頭指名自己的 agent，賣方從節點確認它是 Active，而且付款帳號就是它鏈上的 agentWallet
    const req = (transportContext as { request?: { adapter?: { req?: express.Request } } } | undefined)?.request?.adapter?.req;
    const buyerAgent = await checkBuyerAgent(req?.header(BUYER_AGENT_HEADER), sender, BUYER_AGENT_POLICY, (id) => readAgent(id));
    if (!buyerAgent.ok) {
      console.log(`refused buyer agent from ${sender}: ${buyerAgent.reason}`);
      // 原因代碼放在 reason：x402 只把 reason 回給買方（message 會被丟掉）
      return { abort: true, reason: `buyer_agent_check_failed:${buyerAgent.code}`, message: buyerAgent.reason };
    }
    if (buyerAgent.named && req?.res) req.res.locals.buyerAgent = buyerAgent;
    if (!REQUIRE_ELIGIBILITY) return;
    // 每一筆付款都重新檢查證明（不只看資料庫有沒有紀錄）；節點連不上也拒絕，不退回只看資料庫
    try {
      if (!sender) throw new Error("no payer");
      await eligibility.recheck(sender);
    } catch (e) {
      console.log(`refused buyer ${sender}: ${e instanceof Error ? e.message : e}`);
      return {
        abort: true,
        reason: "buyer_proof_required",
        message: `Account ${sender} has no current eligibility proof that passes the check at payment time. Verify at ${PUBLIC_URL}/verify?account=${sender}`,
      };
    }
  })
  // facilitator 回報結算失敗時：先記錄原因；若它給了交易雜湊，就自己從節點確認錢是否真的付了，付了就照常交貨
  .onSettleFailure(async ({ error, paymentPayload, requirements }) => {
    const e = error as Error & { errorReason?: string; errorMessage?: string; transaction?: string };
    const payer = payerOf(paymentPayload.payload);
    console.warn(`settlement reported failure: ${e.errorReason ?? e.message}${e.errorMessage && e.errorMessage !== e.errorReason ? ` (${e.errorMessage})` : ""} tx=${e.transaction || "-"} payer=${payer ?? "-"}`);
    if (!e.transaction || !payer) return;
    const paid = await paidOnChain(e.transaction, payer, requirements.payTo, requirements.amount, requirements.asset);
    if (!paid.ok) {
      console.warn(`not recovered: ${paid.why}`);
      return;
    }
    console.log(`recovered: ${e.transaction} is finalized and pays ${requirements.amount} to ${requirements.payTo}`);
    return { recovered: true as const, result: { success: true, transaction: e.transaction, network: requirements.network, payer } };
  })
  // 結算前再讀一次：驗證到結算之間（中間會上鏈）agent 被撤銷或換了錢包，就不收這筆錢
  .onBeforeSettle(async ({ paymentPayload, transportContext }) => {
    const req = (transportContext as { request?: { adapter?: { req?: express.Request } } } | undefined)?.request?.adapter?.req;
    const named = req?.res?.locals.buyerAgent as Extract<BuyerAgentResult, { named: true }> | undefined;
    if (!named) return;
    const again = await checkBuyerAgent(named.tokenId, payerOf(paymentPayload.payload), BUYER_AGENT_POLICY, (id) => readAgent(id));
    if (!again.ok || !again.named || again.wallet !== named.wallet) {
      console.log(`refused at settlement, buyer agent #${named.tokenId}: ${again.ok ? "wallet changed" : again.reason}`);
      return { abort: true, reason: `buyer_agent_check_failed:${again.ok ? "wallet_changed" : again.code}` };
    }
  });

const app = express();
app.disable("x-powered-by");
// 部署在反向代理後面（Hugging Face / Render）時，用 X-Forwarded-For 取得真實 IP、X-Forwarded-Proto 判斷 HTTPS
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || 1);
// 全站基本上限（每 IP 每分鐘）；個別路由另有更嚴的限制（例如會花 CCD 的 /eligibility/challenge）
app.use(baselineLimit({ windowMs: 60_000, limit: Number(env("REQUESTS_PER_MIN", "300")), standardHeaders: "draft-8", legacyHeaders: false }));
// sendFile 預設會設 Cache-Control: public, max-age=0，蓋掉安全標頭的 no-store
const NO_CACHE_FILE = { cacheControl: false, lastModified: false } as const;
const pages = [new URL("../public/index.html", import.meta.url).pathname, new URL("../public/verify.html", import.meta.url).pathname];
app.use(securityHeaders(inlineScriptHashes(pages), ["/verify"], inlineScriptHashes(pages, "style")));
app.use(express.json({ limit: "256kb" }));

// 速率限制：challenge 每次都花 CCD 上鏈，限制最嚴；全站上限換 IP 也繞不過
const MIN = 60_000;
const ip = (req: express.Request) => req.ip ?? "unknown";
const validAccount = (req: express.Request) => {
  const a = String(req.body?.account ?? "");
  return /^[1-9A-HJ-NP-Za-km-z]{50}$/.test(a) ? a : null;
};
const limitChallenge = rateLimit([
  { limiter: new RateLimiter(5, 10 * MIN), key: ip, what: "per IP" },
  // 帳號格式不對的請求根本不會上鏈：不吃掉這個帳號或全站的額度（每 IP 的限制照算）
  { limiter: new RateLimiter(3, 60 * MIN), key: (req) => validAccount(req) ?? undefined, what: "per account" },
  { limiter: new RateLimiter(Number(env("CHALLENGES_PER_HOUR", "60")), 60 * MIN), key: (req) => (validAccount(req) ? "all" : undefined), what: "site-wide hourly budget" },
]);
const limitVerify = rateLimit([{ limiter: new RateLimiter(10, 10 * MIN), key: ip, what: "per IP" }]);
const limitRead = rateLimit([{ limiter: new RateLimiter(120, MIN), key: ip, what: "per IP" }]);

app.use(
  paymentMiddleware(
    {
      "GET /signal/:asset": {
        accepts: [
          { asset: "CCD", amount: PRICE_MICROCCD },
          ...(PLT_PRICE ? [PLT_PRICE] : []),
        ].map((p) => ({
          scheme: "exact",
          network: NETWORK,
          payTo: PAY_TO,
          price: {
            amount: p.amount,
            asset: p.asset,
            // 讓買方 agent 在付款前就知道要先證明資格（格式參考 x402 issue #4182 的 buyerProof 提案）
            extra: {
              buyerProof: ["adult", "region"],
              buyerProofPolicy: eligibility.describe(),
              buyerProofUrl: `${PUBLIC_URL}/verify`,
              // 買方 agent 可以用這個標頭指名自己在 CIS-8004 的 token id；賣方從節點核對付款帳號＝它的 agentWallet
              buyerAgentHeader: "X-Concordium-Agent",
              buyerAgentPolicy: BUYER_AGENT_POLICY,
            },
          },
        })),
        description: "VeriFlow risk-regime signal (RISK_ON / RISK_OFF), committed on-chain",
        mimeType: "application/json",
        // 指名收款的 agent（CIS-8004 的 registry 與 token id）。不放錢包：買方從鏈上讀 agentWallet 再比對 payTo
        extensions: {
          [AGENT_EXTENSION]: {
            info: { network: NETWORK, registry: `${AGENT_REGISTRY.index}.${AGENT_REGISTRY.subindex}`, badge: AGENT_BADGE, tokenId: AGENT_TOKEN_ID },
            schema: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              additionalProperties: false,
              required: ["network", "registry", "badge", "tokenId"],
              properties: {
                network: { type: "string", pattern: "^ccd:[0-9a-f]{32}$" },
                registry: { type: "string", pattern: "^[0-9]+\\.[0-9]+$" },
                badge: { type: "string", pattern: "^[1-9A-HJ-NP-Za-km-z]{10,40}$" },
                tokenId: { type: "string", pattern: "^[0-9]+$" },
              },
            },
          },
        },
      },
    },
    resourceServer,
  ),
);

async function forward(path: string, res: express.Response, paid: boolean) {
  try {
    const r = await fetch(`${API_URL}${path}`, {
      headers: paid ? { "X-VeriFlow-Gateway": GATEWAY_SECRET } : {},
    });
    res.status(r.status).type("application/json").send(await r.text());
  } catch (e) {
    res.status(502).json({ error: `VeriFlow API unreachable: ${String(e)}` });
  }
}

// 付款成功 → 向 Python API 拿訊號 → 把承諾雜湊寫上鏈 → 通知 API 記下交易 hash → 回傳給買方
const anchorer = createAnchorer(env("ANCHOR_KEY_FILE", env("FACILITATOR_KEY_FILE")));

app.get("/signal/:asset", async (req, res) => {
  try {
    const r = await fetch(`${API_URL}/signal/${encodeURIComponent(req.params.asset)}`, {
      headers: { "X-VeriFlow-Gateway": GATEWAY_SECRET },
    });
    const body = await r.json();
    if (!r.ok) return res.status(r.status).json(body);

    // 當天的官方訊號已經上鏈（每日排程或先前的買家）：直接賣同一筆，不重複上鏈
    if (!body.anchor_tx) {
      try {
        const tx = await anchorer.anchor(body.commitment, String(body.signal?.asset ?? req.params.asset).toUpperCase());
        await fetch(`${API_URL}/commitments/${body.commitment}/anchor`, {
          method: "POST",
          headers: { "X-VeriFlow-Gateway": GATEWAY_SECRET, "Content-Type": "application/json" },
          body: JSON.stringify({ anchor_tx: tx }),
        });
        body.anchor_tx = tx;
        console.log(`anchored ${body.commitment.slice(0, 12)}… → ${tx}`);
      } catch (e) {
        // 沒上鏈的訊號不能證明是事前發的：回錯誤，x402 只在成功回應時結算，所以買方不會被扣款
        console.error("anchor failed:", e);
        return res.status(503).json({ error: "anchor_failed", detail: "The signal could not be committed on-chain, so it was not sold and you were not charged. Try again shortly." });
      }
    }
    const ba = res.locals.buyerAgent as Extract<BuyerAgentResult, { named: true }> | undefined;
    if (ba) body.buyer_agent = { token_id: ba.tokenId, registry: `<${AGENT_REGISTRY.index},${AGENT_REGISTRY.subindex}>`, owner: ba.owner, agent_wallet: ba.wallet, checked: "read from a Concordium node before verification and again before settlement: Active, and the payer is its agentWallet" };
    res.json(body);
  } catch (e) {
    res.status(502).json({ error: `VeriFlow API unreachable: ${String(e)}` });
  }
});
app.get("/track-record", (_req, res) => forward("/track-record", res, false));
app.get("/commitments", (_req, res) => forward("/commitments", res, false));
app.get("/commitments/:c", (req, res) => forward(`/commitments/${encodeURIComponent(req.params.c)}`, res, false));

// 公開：從 Concordium 讀回上鏈的承諾（給儀表板的「一鍵驗證」用）
app.get("/onchain/:tx", limitRead, async (req, res) => {
  if (!/^[0-9a-f]{64}$/.test(String(req.params.tx))) return res.status(400).json({ error: "tx 格式錯誤" });
  try {
    res.json(await anchorer.read(String(req.params.tx)));
  } catch (e) {
    res.status(502).json({ error: `Concordium node error: ${String(e)}` });
  }
});
// 營運帳號餘額：每日上鏈、自動公開、贊助買方手續費都從這個帳號扣，用完紀錄就會中斷
// 背景每 10 分鐘查一次（/health 只回快取，不拖慢健康檢查）；低於 MIN_OPERATOR_CCD 時 low=true
const MIN_OPERATOR_CCD = Number(env("MIN_OPERATOR_CCD", "100"));
const operator: { account: string; balance_ccd: number | null; checked_at: string | null; low: boolean } = {
  account: "",
  balance_ccd: null,
  checked_at: null,
  low: false,
};
async function refreshOperatorBalance() {
  try {
    const ccd = Number(await anchorer.balanceMicroCcd()) / 1e6;
    Object.assign(operator, { balance_ccd: ccd, checked_at: new Date().toISOString(), low: ccd < MIN_OPERATOR_CCD });
    if (operator.low) console.warn(`operator ${operator.account} balance ${ccd} CCD is below ${MIN_OPERATOR_CCD} CCD — top up from the testnet faucet`);
  } catch (e) {
    console.warn(`operator balance check failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

app.get("/health", limitRead, async (_req, res) => {
  try {
    const r = await fetch(`${API_URL}/health`);
    const api = (await r.json()) as Record<string, unknown>;
    res.status(r.status).json({ ...api, operator });
  } catch (e) {
    res.status(502).json({ ok: false, error: `VeriFlow API unreachable: ${String(e)}`, operator });
  }
});

// ── 買方資格驗證（Verify & Access）─────────────────────
const verifyPage = new URL("../public/verify.html", import.meta.url);
app.get("/verify", limitRead, (_req, res) => res.sendFile(verifyPage.pathname, NO_CACHE_FILE));

// 公開儀表板（瀏覽器自己重算雜湊驗證，不用信任這台伺服器）與 Agent Card
const dashboardPage = new URL("../public/index.html", import.meta.url);
app.get("/", limitRead, (_req, res) => res.sendFile(dashboardPage.pathname, NO_CACHE_FILE));
const agentCard = new URL("../../agent-card.json", import.meta.url);
app.get("/.well-known/agent-card.json", limitRead, (_req, res) => res.type("application/json").sendFile(agentCard.pathname, NO_CACHE_FILE));
// 示範買方 agent 的 Agent Card（它在 CIS-8004 登記時釘住這個檔案的 SHA-256，所以內容不能再改）
const buyerCard = new URL("../../agents/buyer-agent-card.json", import.meta.url);
app.get("/agents/buyer-agent-card.json", limitRead, (_req, res) => res.type("application/json").sendFile(buyerCard.pathname, NO_CACHE_FILE));

app.post("/eligibility/challenge", limitChallenge, async (req, res) => {
  try {
    const r = await eligibility.challenge(String(req.body?.account ?? ""));
    console.log(`verification request anchored (VRA) ${r.requestAnchorTx}`);
    res.json(r);
  } catch (e) {
    console.error("challenge failed:", e);
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

app.post("/eligibility/verify", limitVerify, async (req, res) => {
  const { id, presentation } = req.body ?? {};
  try {
    const json = typeof presentation === "string" ? presentation : JSON.stringify(presentation);
    const rec = await eligibility.verify(String(id), json);
    console.log(`eligible: ${rec.account} (idp ${rec.issuer})  VRA ${rec.requestAnchorTx}  VAA ${rec.auditAnchorTx}`);
    const { presentationJson: _p, requestJson: _r, credId: _c, challengeId: _i, ...out } = rec;
    res.json({ eligible: true, ...out });
  } catch (e) {
    console.log("eligibility refused:", e instanceof Error ? e.message : e);
    res.status(403).json({ eligible: false, error: String(e instanceof Error ? e.message : e) });
  }
});

app.get("/eligibility/:account", (req, res) => {
  const rec = eligibility.status(req.params.account);
  // 公開端點不回傳 credential id（雖然它本來就在鏈上，但不需要讓人把帳號和身分憑證對起來）
  const { credId: _c, presentationJson: _p, requestJson: _r, challengeId: _i, ...pub } = rec ?? ({} as Record<string, unknown>);
  // policy 放最後：rec 裡也有 policy（指紋字串），不能讓它蓋掉完整的政策說明
  res.json({ eligible: !!rec, ...pub, policyId: rec?.policy, policy: eligibility.describe() });
});

// 公開版 MCP（Streamable HTTP）：免費工具 + 購買說明，不碰任何人的金鑰
const SELF_URL = `http://127.0.0.1:${env("GATEWAY_PORT", "4020")}`;
mountRemoteMcp(app, { selfUrl: SELF_URL, publicUrl: PUBLIC_URL });
// A2A（Agent Card 的 url 指向這裡）：同樣只有唯讀技能
mountA2A(app, { selfUrl: SELF_URL, publicUrl: PUBLIC_URL });

// 找不到的路徑與未預期錯誤：自己回 JSON，保留上面設好的安全標頭
// （Express 預設的錯誤頁會換成它自己的 CSP，ZAP 會抓到缺少 frame-ancestors 等規則）
app.use((_req, res) => res.status(404).json({ error: "not_found" }));
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("unhandled:", err);
  if (!res.headersSent) res.status(500).json({ error: "internal_error" });
});

const PORT = Number(env("GATEWAY_PORT", "4020"));
// 每日公開訊號：績效紀錄每天累積（DAILY_SIGNALS=off 可關閉；本機開發預設關閉）
// DAILY_SIGNALS=reveal：v2 上線後，v1 不再發新訊號（v2 由 GitHub Actions 的 daily-v2 產生），只繼續公開 v1 到期的承諾
const DAILY_MODE = env("DAILY_SIGNALS", "off");
const DAILY = DAILY_MODE !== "off";
if (DAILY) {
  startDailySignals(
    {
      apiUrl: API_URL,
      secret: GATEWAY_SECRET,
      assets: DAILY_MODE === "reveal" ? [] : env("DAILY_ASSETS", "BTC,ETH").split(",").map((a) => a.trim().toUpperCase()).filter(Boolean),
      anchor: (c, asset) => anchorer.anchor(c, asset),
      log: (m) => console.log(m),
    },
    Number(env("DAILY_INTERVAL_MIN", "30")) * 60_000,
    60_000,
    // 到期自動公開：合約模式才有（合約自己重算雜湊）
    anchorer.contract && {
      apiUrl: API_URL,
      record: anchorer.contract.record,
      reveal: anchorer.contract.reveal,
      log: (m) => console.log(m),
    },
  );
}

operator.account = anchorer.address;
setTimeout(refreshOperatorBalance, 5_000);
setInterval(refreshOperatorBalance, 10 * 60_000);

// SDK 有些檢查內部沒有 await（例如 createChecked 的 context 檢查）：一個壞的證明不能讓整個伺服器結束
process.on("unhandledRejection", (e) => console.warn(`unhandled rejection (ignored): ${e instanceof Error ? e.message : e}`));

// 節點必須屬於 CONCORDIUM_NETWORK 選的那條鏈：開始接受連線之前先查，之後每分鐘再查一次。
// 連不上只警告（節點暫時不通不該讓網站掛掉），選錯鏈就停。
const checkNetwork = (): Promise<boolean> =>
    createGrpc()
      .getConsensusStatus()
      .then((c) => checkGenesis(BlockHash.toHexString(c.genesisBlock)))
      .then(() => (console.log(`network: ${NET.name} (${NET.caip2})`), true))
      .catch((e) => {
        if (/is not (testnet|mainnet)/.test(String(e))) {
          console.error(`❌ ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        }
        console.warn(`network check skipped: ${e instanceof Error ? e.message : e}`);
        return false;
      });
// 開始接受連線之前，最多試 3 次（每次 gRPC 20 秒逾時）拿到節點的 genesis；錯鏈就停。
// 3 次都拿不到才先啟動（節點不通時付款本來就做不了），之後每分鐘再查。
for (let i = 0; i < 3 && !(await Promise.race([checkNetwork(), new Promise<boolean>((r) => setTimeout(() => r(false), 25_000))])); i++);
setInterval(checkNetwork, 60_000).unref();

app.listen(PORT, () => {
  console.log(`gateway on http://localhost:${PORT}  payTo=${PAY_TO}  price=${PRICE_MICROCCD} microCCD${PLT_PRICE ? ` or ${PLT_PRICE.amount} ${PLT_PRICE.asset} units` : ""}  anchor=${anchorer.address} via ${anchorer.mode}`);
  console.log(`daily public signals: ${DAILY_MODE === "reveal" ? "v1 reveals only (v2 signals come from the daily-v2 workflow)" : DAILY ? "on" : "off"}`);
  console.log(`buyer eligibility ${REQUIRE_ELIGIBILITY ? "REQUIRED" : "off"}: age ≥ ${MIN_AGE}, not resident in ${eligibility.policy.restrictedCountries.join(",")}  → ${PUBLIC_URL}/verify`);
});
