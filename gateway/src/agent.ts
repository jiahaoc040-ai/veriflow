/**
 * 買方 Agent 的付款工具（示範 buyer 與 MCP server 共用）
 * ----------------------------------------------------
 * 花費護欄：只付 Concordium testnet 的 CCD，單次最多 MAX_PAY_MICROCCD（預設 2 CCD）。
 * 賣方要求更多錢或別種資產，Agent 會拒絕付款。
 */
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactConcordiumScheme } from "@x402/concordium/exact/client";
import { getExplorerTxUrl } from "@x402/concordium";
import { NETWORK, env, loadAccount } from "./config.js";

export function createBuyerAgent() {
  const buyer = loadAccount(env("BUYER_KEY_FILE"));
  const gateway = env("GATEWAY_URL", "http://localhost:4020");
  const maxPay = env("MAX_PAY_MICROCCD", "2000000");
  const client = x402Client.fromConfig({
    schemes: [
      { network: NETWORK, client: new ExactConcordiumScheme({ accountAddress: buyer.accountAddress, signer: buyer.signer }) },
    ],
    spendControls: { allowedAssets: [{ network: NETWORK, asset: "CCD", maxAmountPerPayment: maxPay }] },
  });
  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  return {
    address: buyer.address,
    gateway,
    maxPayMicroCcd: maxPay,

    /** 付款買一個訊號。回傳 HTTP 狀態、內容，以及付款交易（如果有付） */
    async buySignal(asset: string) {
      const res = await fetchWithPay(`${gateway}/signal/${encodeURIComponent(asset.toUpperCase())}`);
      const text = await res.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* 非 JSON 就保留原文 */ }
      const header = res.headers.get("PAYMENT-RESPONSE") ?? res.headers.get("X-PAYMENT-RESPONSE");
      const payment = header ? decodePaymentResponseHeader(header) : undefined;
      return {
        status: res.status,
        body,
        payment,
        paymentExplorer: payment?.transaction ? getExplorerTxUrl(NETWORK, payment.transaction) : undefined,
        needsVerification: !res.ok && text.includes("buyer_proof_required"),
        verifyUrl: `${gateway}/verify?account=${buyer.address}`,
      };
    },

    /** 不付款的公開端點 */
    async get(path: string) {
      const res = await fetch(`${gateway}${path}`);
      if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${await res.text()}`);
      return res.json();
    },
  };
}
