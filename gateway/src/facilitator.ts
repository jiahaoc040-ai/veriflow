/**
 * 自架的 x402 facilitator（Concordium testnet）
 * -------------------------------------------
 * 工作：驗證買方簽好的轉帳 → 以 sponsor 身分加簽、代付手續費 → 送上鏈 → 等最終確認。
 * 找不到公開的 Concordium x402 facilitator，所以自己架（官方套件提供完整實作）。
 *
 * 執行：npm run facilitator   （預設 http://localhost:4021）
 *
 * 斷線處理：連線閒置太久可能被網路設備悄悄斷掉（症狀：read ETIMEDOUT）。
 *   - /verify 遇到網路錯誤 → 重建連線、自動再試一次（verify 不動到錢，重試安全）
 *   - /settle 遇到網路錯誤 → 重建連線，但不自動重送（避免重複結算），回報錯誤讓買方重試
 */
import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactConcordiumScheme } from "@x402/concordium/exact/facilitator";
import { toConcordiumFacilitatorSigner } from "@x402/concordium";
import { NETWORK, env, loadAccount } from "./config.js";
import { grpcEndpoint, isTransient } from "./grpc.js";

const sponsor = loadAccount(env("FACILITATOR_KEY_FILE"));

/** 建一個全新的 facilitator（含全新的節點連線） */
function build() {
  const [host, port] = grpcEndpoint();
  const signer = toConcordiumFacilitatorSigner(sponsor.address, sponsor.signer, { host, port, useTls: true, network: NETWORK });
  return new x402Facilitator().register(NETWORK, new ExactConcordiumScheme({ signer }));
}

let facilitator = build();
function reconnect(why: unknown) {
  console.log(`node connection reset (${why instanceof Error ? why.message : String(why)})`);
  facilitator = build();
}

/** verify 的錯誤可能是丟例外，也可能包在 invalidReason 裡（例如 signature_verification_failed: read ETIMEDOUT） */
const transientResult = (r: { isValid?: boolean; invalidReason?: string }) => r.isValid === false && isTransient(r.invalidReason ?? "");

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/supported", (_req, res) => {
  res.json(facilitator.getSupported());
});

app.post("/verify", async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body;
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await facilitator.verify(paymentPayload, paymentRequirements);
      if (attempt === 1 && transientResult(r)) {
        reconnect(r.invalidReason);
        continue;
      }
      return res.json(r);
    } catch (e) {
      if (attempt === 1 && isTransient(e)) {
        reconnect(e);
        continue;
      }
      return res.status(500).json({ error: String(e) });
    }
  }
});

app.post("/settle", async (req, res) => {
  try {
    const result = await facilitator.settle(req.body.paymentPayload, req.body.paymentRequirements);
    console.log("settled:", JSON.stringify(result));
    if (!result.success && isTransient(result.errorReason ?? "")) reconnect(result.errorReason);
    res.json(result);
  } catch (e) {
    if (isTransient(e)) reconnect(e);
    res.status(500).json({ error: String(e) });
  }
});

const PORT = Number(env("FACILITATOR_PORT", "4021"));
app.listen(PORT, () => {
  console.log(`facilitator on http://localhost:${PORT}  sponsor=${sponsor.address}  network=${NETWORK}`);
});
