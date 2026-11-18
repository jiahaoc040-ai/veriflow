/**
 * VeriFlow x402 付款關卡
 * ---------------------
 * GET /signal/:asset 要先付款（x402，Concordium testnet CCD）。
 * 付款驗證通過後，帶著共用密鑰轉發到 Python API；Python API 只認這把密鑰，
 * 所以沒付款的人沒辦法繞過關卡直接拿訊號。
 *
 * 公開端點（/track-record、/commitments、/health）直接轉發，不收費。
 *
 * 執行：npm run gateway   （預設 http://localhost:4020）
 */
import express from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactConcordiumScheme } from "@x402/concordium/exact/server";
import { NETWORK, env } from "./config.js";
import { createAnchorer } from "./anchor.js";

const API_URL = env("API_URL", "http://127.0.0.1:8000");
const GATEWAY_SECRET = env("GATEWAY_SECRET");
const PAY_TO = env("SELLER_ADDRESS");
const PRICE_MICROCCD = env("PRICE_MICROCCD", "1000000"); // 1 CCD

const resourceServer = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: env("FACILITATOR_URL", "http://localhost:4021") }),
).register(NETWORK, new ExactConcordiumScheme());

const app = express();

app.use(
  paymentMiddleware(
    {
      "GET /signal/:asset": {
        accepts: [
          {
            scheme: "exact",
            network: NETWORK,
            payTo: PAY_TO,
            price: { amount: PRICE_MICROCCD, asset: "CCD" },
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

const PORT = Number(env("GATEWAY_PORT", "4020"));
app.listen(PORT, () => {
  console.log(`gateway on http://localhost:${PORT}  payTo=${PAY_TO}  price=${PRICE_MICROCCD} microCCD  anchor=${anchorer.address}`);
});
