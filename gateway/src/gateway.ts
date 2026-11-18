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
import { NETWORK, env } from "./config.js";
import { createAnchorer } from "./anchor.js";
import { EligibilityService, EligibilityStore, MIN_AGE, concordiumChain, parseCountries } from "./eligibility.js";

const API_URL = env("API_URL", "http://127.0.0.1:8000");
const GATEWAY_SECRET = env("GATEWAY_SECRET");
const PAY_TO = env("SELLER_ADDRESS");
const PRICE_MICROCCD = env("PRICE_MICROCCD", "1000000"); // 1 CCD

const PUBLIC_URL = env("PUBLIC_URL", "http://localhost:4020");

const eligibility = new EligibilityService(
  { minAge: MIN_AGE, restrictedCountries: parseCountries(process.env.RESTRICTED_COUNTRIES) },
  new EligibilityStore(env("ELIGIBILITY_FILE", "data/eligibility.json")),
  concordiumChain(),
);
const REQUIRE_ELIGIBILITY = env("REQUIRE_ELIGIBILITY", "true") !== "false";

const resourceServer = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: env("FACILITATOR_URL", "http://localhost:4021") }),
)
  .register(NETWORK, new ExactConcordiumScheme())
  // 付款交易送去結算之前：sender 沒通過資格驗證 → 拒絕（交易不會上鏈，買方不會被扣款）
  .onBeforeVerify(async ({ paymentPayload }) => {
    if (!REQUIRE_ELIGIBILITY) return;
    const sender = (paymentPayload.payload as { header?: { sender?: string } })?.header?.sender;
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
app.use(express.json({ limit: "256kb" }));

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
      const tx = await anchorer.anchor(body.commitment);
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
app.get("/onchain/:tx", async (req, res) => {
  if (!/^[0-9a-f]{64}$/.test(req.params.tx)) return res.status(400).json({ error: "tx 格式錯誤" });
  try {
    res.json(await anchorer.read(req.params.tx));
  } catch (e) {
    res.status(502).json({ error: `Concordium node error: ${String(e)}` });
  }
});
app.get("/health", (_req, res) => forward("/health", res, false));

// ── 買方資格驗證（Verify & Access）─────────────────────
const verifyPage = new URL("../public/verify.html", import.meta.url);
app.get("/verify", (_req, res) => res.sendFile(verifyPage.pathname));

app.post("/eligibility/challenge", async (req, res) => {
  try {
    res.json(await eligibility.challenge(String(req.body?.account ?? "")));
  } catch (e) {
    res.status(400).json({ error: String(e instanceof Error ? e.message : e) });
  }
});

app.post("/eligibility/verify", async (req, res) => {
  const { challenge, presentation } = req.body ?? {};
  try {
    const json = typeof presentation === "string" ? presentation : JSON.stringify(presentation);
    const rec = await eligibility.verify(String(challenge), json);
    console.log(`eligible: ${rec.account} (idp ${rec.issuer})`);
    res.json({ eligible: true, ...rec });
  } catch (e) {
    console.log("eligibility refused:", e instanceof Error ? e.message : e);
    res.status(403).json({ eligible: false, error: String(e instanceof Error ? e.message : e) });
  }
});

app.get("/eligibility/:account", (req, res) => {
  const rec = eligibility.status(req.params.account);
  res.json({ eligible: !!rec, policy: eligibility.describe(), ...(rec ?? {}) });
});

const PORT = Number(env("GATEWAY_PORT", "4020"));
app.listen(PORT, () => {
  console.log(`gateway on http://localhost:${PORT}  payTo=${PAY_TO}  price=${PRICE_MICROCCD} microCCD  anchor=${anchorer.address}`);
  console.log(`buyer eligibility ${REQUIRE_ELIGIBILITY ? "REQUIRED" : "off"}: age ≥ ${MIN_AGE}, not resident in ${eligibility.policy.restrictedCountries.join(",")}  → ${PUBLIC_URL}/verify`);
});
