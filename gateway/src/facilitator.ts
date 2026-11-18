/**
 * 自架的 x402 facilitator（Concordium testnet）
 * -------------------------------------------
 * 工作：驗證買方簽好的轉帳 → 以 sponsor 身分加簽、代付手續費 → 送上鏈 → 等最終確認。
 * 找不到公開的 Concordium x402 facilitator，所以自己架（官方套件提供完整實作）。
 *
 * 執行：npm run facilitator   （預設 http://localhost:4021）
 */
import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactConcordiumScheme } from "@x402/concordium/exact/facilitator";
import { getConcordiumGrpcUrl, parseGrpcUrl, toConcordiumFacilitatorSigner } from "@x402/concordium";
import { NETWORK, env, loadAccount } from "./config.js";

const sponsor = loadAccount(env("FACILITATOR_KEY_FILE"));
const [host, port] = parseGrpcUrl(getConcordiumGrpcUrl(NETWORK));
const signer = toConcordiumFacilitatorSigner(sponsor.address, sponsor.signer, {
  host,
  port,
  useTls: true,
  network: NETWORK,
});

const facilitator = new x402Facilitator().register(NETWORK, new ExactConcordiumScheme({ signer }));

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/supported", (_req, res) => {
  res.json(facilitator.getSupported());
});

app.post("/verify", async (req, res) => {
  try {
    res.json(await facilitator.verify(req.body.paymentPayload, req.body.paymentRequirements));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/settle", async (req, res) => {
  try {
    const result = await facilitator.settle(req.body.paymentPayload, req.body.paymentRequirements);
    console.log("settled:", JSON.stringify(result));
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const PORT = Number(env("FACILITATOR_PORT", "4021"));
app.listen(PORT, () => {
  console.log(`facilitator on http://localhost:${PORT}  sponsor=${sponsor.address}  network=${NETWORK}`);
});
