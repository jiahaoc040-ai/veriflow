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
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactConcordiumScheme } from "@x402/concordium/exact/server";
import { GATEWAY_DIR, NETWORK, env } from "./config.js";
import { resolve } from "node:path";
import { createAnchorer } from "./anchor.js";
import { RateLimiter, inlineScriptHashes, rateLimit, securityHeaders } from "./security.js";
import { EligibilityService, EligibilityStore, filePersistence, postgresPersistence, MIN_AGE, concordiumChain, parseCountries, payerOf } from "./eligibility.js";

const API_URL = env("API_URL", "http://127.0.0.1:8000");
const GATEWAY_SECRET = env("GATEWAY_SECRET");
const PAY_TO = env("SELLER_ADDRESS");
const PRICE_MICROCCD = env("PRICE_MICROCCD", "1000000"); // 1 CCD

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

// 免費主機只有 512 MB：EMBED_FACILITATOR=1 時 facilitator 跑在同一個 Node 程序裡（省約 130 MB）。
// 必須在建立付款中介層「之前」啟動並等它開始監聽，否則中介層啟動時查詢 /supported 會失敗。
if (process.env.EMBED_FACILITATOR) await (await import("./facilitator.js")).listening;

const resourceServer = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: env("FACILITATOR_URL", "http://localhost:4021") }),
)
  .register(NETWORK, new ExactConcordiumScheme())
  // 付款交易送去結算之前：sender 沒通過資格驗證 → 拒絕（交易不會上鏈，買方不會被扣款）
  .onBeforeVerify(async ({ paymentPayload }) => {
    if (!REQUIRE_ELIGIBILITY) return;
    const sender = payerOf(paymentPayload.payload);
    if (!sender || !eligibility.status(sender)) {
      console.log(`refused unverified buyer ${sender}`);
      return {
        abort: true,
        reason: "buyer_proof_required",
        message: `Account ${sender} has not proven eligibility. Verify once at ${PUBLIC_URL}/verify?account=${sender}`,
      };
    }
  });

const app = express();
app.disable("x-powered-by");
// 部署在反向代理後面（Hugging Face / Render）時，用 X-Forwarded-For 取得真實 IP、X-Forwarded-Proto 判斷 HTTPS
if (process.env.TRUST_PROXY) app.set("trust proxy", Number(process.env.TRUST_PROXY) || 1);
app.use(
  securityHeaders(
    inlineScriptHashes([new URL("../public/index.html", import.meta.url).pathname, new URL("../public/verify.html", import.meta.url).pathname]),
    ["/verify"],
  ),
);
app.use(express.json({ limit: "256kb" }));

// 速率限制：challenge 每次都花 CCD 上鏈，限制最嚴；全站上限換 IP 也繞不過
const MIN = 60_000;
const ip = (req: express.Request) => req.ip ?? "unknown";
const limitChallenge = rateLimit([
  { limiter: new RateLimiter(5, 10 * MIN), key: ip, what: "per IP" },
  { limiter: new RateLimiter(3, 60 * MIN), key: (req) => String(req.body?.account ?? ""), what: "per account" },
  { limiter: new RateLimiter(Number(env("CHALLENGES_PER_HOUR", "60")), 60 * MIN), key: () => "all", what: "site-wide hourly budget" },
]);
const limitVerify = rateLimit([{ limiter: new RateLimiter(10, 10 * MIN), key: ip, what: "per IP" }]);
const limitRead = rateLimit([{ limiter: new RateLimiter(120, MIN), key: ip, what: "per IP" }]);

app.use(
  paymentMiddleware(
    {
      "GET /signal/:asset": {
        accepts: [
          {
            scheme: "exact",
            network: NETWORK,
            payTo: PAY_TO,
            price: {
              amount: PRICE_MICROCCD,
              asset: "CCD",
              // 讓買方 agent 在付款前就知道要先證明資格（格式參考 x402 issue #4182 的 buyerProof 提案）
              extra: {
                buyerProof: ["adult", "region"],
                buyerProofPolicy: eligibility.describe(),
                buyerProofUrl: `${PUBLIC_URL}/verify`,
              },
            },
          },
        ],
        description: "VeriFlow risk-regime signal (RISK_ON / RISK_OFF), committed on-chain",
        mimeType: "application/json",
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
      // 上鏈失敗不擋買方拿訊號，但要標示出來
      body.anchor_error = String(e);
      console.error("anchor failed:", e);
    }
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
app.get("/health", (_req, res) => forward("/health", res, false));

// ── 買方資格驗證（Verify & Access）─────────────────────
const verifyPage = new URL("../public/verify.html", import.meta.url);
app.get("/verify", (_req, res) => res.sendFile(verifyPage.pathname));

// 公開儀表板（瀏覽器自己重算雜湊驗證，不用信任這台伺服器）與 Agent Card
const dashboardPage = new URL("../public/index.html", import.meta.url);
app.get("/", (_req, res) => res.sendFile(dashboardPage.pathname));
const agentCard = new URL("../../agent-card.json", import.meta.url);
app.get("/.well-known/agent-card.json", (_req, res) => res.type("application/json").sendFile(agentCard.pathname));

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
    res.json({ eligible: true, ...rec });
  } catch (e) {
    console.log("eligibility refused:", e instanceof Error ? e.message : e);
    res.status(403).json({ eligible: false, error: String(e instanceof Error ? e.message : e) });
  }
});

app.get("/eligibility/:account", (req, res) => {
  const rec = eligibility.status(req.params.account);
  // policy 放最後：rec 裡也有 policy（指紋字串），不能讓它蓋掉完整的政策說明
  res.json({ eligible: !!rec, ...(rec ?? {}), policyId: rec?.policy, policy: eligibility.describe() });
});

const PORT = Number(env("GATEWAY_PORT", "4020"));
app.listen(PORT, () => {
  console.log(`gateway on http://localhost:${PORT}  payTo=${PAY_TO}  price=${PRICE_MICROCCD} microCCD  anchor=${anchorer.address} via ${anchorer.mode}`);
  console.log(`buyer eligibility ${REQUIRE_ELIGIBILITY ? "REQUIRED" : "off"}: age ≥ ${MIN_AGE}, not resident in ${eligibility.policy.restrictedCountries.join(",")}  → ${PUBLIC_URL}/verify`);
});
