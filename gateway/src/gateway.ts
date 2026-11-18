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

app.get("/signal/:asset", (req, res) => forward(`/signal/${encodeURIComponent(req.params.asset)}`, res, true));
app.get("/track-record", (_req, res) => forward("/track-record", res, false));
app.get("/commitments", (_req, res) => forward("/commitments", res, false));
app.get("/health", (_req, res) => forward("/health", res, false));

const PORT = Number(env("GATEWAY_PORT", "4020"));
app.listen(PORT, () => {
  console.log(`gateway on http://localhost:${PORT}  payTo=${PAY_TO}  price=${PRICE_MICROCCD} microCCD`);
});
