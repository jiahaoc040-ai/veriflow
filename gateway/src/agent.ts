/**
 * 買方 Agent 的付款工具（示範 buyer 與 MCP server 共用）
 * ----------------------------------------------------
 * 花費護欄：只付 Concordium testnet 的 CCD，單次最多 MAX_PAY_MICROCCD（預設 2 CCD）。
 * 賣方要求更多錢或別種資產，Agent 會拒絕付款。
 * 付款前驗證賣方（counterparty.ts）：badge、Registry 狀態、Agent Card 雜湊、payTo＝鏈上 agentWallet，
 * 任一項不過就不簽名（REQUIRE_SELLER_BADGE=false 可在本機開發時關閉）。
 */
import { AGENT_REGISTRY, readAgent } from "./registry-node.js";
import { AGENT_EXTENSION } from "./counterparty.js";
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactConcordiumScheme } from "@x402/concordium/exact/client";
import { getExplorerTxUrl } from "@x402/concordium";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { NETWORK, env, loadAccount } from "./config.js";
import { PUBLIC_GATEWAY } from "./mcp-launch.js";
import { summarize, verifySeller, type SellerVerdict } from "./counterparty.js";
import { REGISTRY_NETWORK, registryTool } from "./registry.js";

export function createBuyerAgent() {
  const buyer = loadAccount(env("BUYER_KEY_FILE"));
  const gateway = env("GATEWAY_URL", PUBLIC_GATEWAY);
  const maxPay = env("MAX_PAY_MICROCCD", "2000000");
  const client = x402Client.fromConfig({
    schemes: [
      { network: NETWORK, client: new ExactConcordiumScheme({ accountAddress: buyer.accountAddress, signer: buyer.signer }) },
    ],
    spendControls: { allowedAssets: [{ network: NETWORK, asset: "CCD", maxAmountPerPayment: maxPay }] },
  });
  const requireSeller = env("REQUIRE_SELLER_BADGE", "true") !== "false";
  let lastSellerCheck: SellerVerdict | undefined;
  /** 402 的 concordium-agent 擴充欄位：只是指名（registry、token id），錢包一律從鏈上讀；網路或 registry 不對就當作沒指名 */
  const namedAgent = (pr: { extensions?: Record<string, unknown> } | undefined, network: string) => {
    const info = (pr?.extensions?.[AGENT_EXTENSION] as { info?: { network?: string; registry?: string; tokenId?: string } } | undefined)?.info;
    if (!info) return undefined;
    if (info.network !== network || info.registry !== `${AGENT_REGISTRY.index}.${AGENT_REGISTRY.subindex}` || !/^\d+$/.test(info.tokenId ?? ""))
      return "mismatch";
    return info.tokenId;
  };
  const checkSeller = async (payTo: string, named?: string) =>
    named === "mismatch"
      ? { ok: false, checks: [{ name: "402 names an agent on this network's registry", ok: false, detail: "concordium-agent extension names another network or registry" }], payTo }
      : verifySeller({ gateway, payTo, registry: registryTool, network: REGISTRY_NETWORK, readAgent: (id) => readAgent(id), expectTokenId: named });

  // 簽名之前的最後一道關卡：賣方驗證不過就中止，錢包根本不會被叫到
  client.onBeforePaymentCreation(async ({ selectedRequirements, paymentRequired }) => {
    if (!requireSeller) return;
    lastSellerCheck = await checkSeller(selectedRequirements.payTo, namedAgent(paymentRequired, selectedRequirements.network));
    if (!lastSellerCheck.ok) return { abort: true as const, reason: summarize(lastSellerCheck) };
  });
  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  return {
    address: buyer.address,
    gateway,
    maxPayMicroCcd: maxPay,

    /** 不付款，只看賣方要我們付給誰，並驗證賣方 */
    async checkSeller(asset = "BTC"): Promise<SellerVerdict> {
      const res = await fetch(`${gateway}/signal/${encodeURIComponent(asset.toUpperCase())}`);
      const header = res.headers.get("PAYMENT-REQUIRED");
      if (res.status !== 402 || !header) throw new Error(`expected an x402 402 response from ${gateway}, got HTTP ${res.status}`);
      const pr = decodePaymentRequiredHeader(header);
      const payTo = pr.accepts?.[0]?.payTo;
      if (!payTo) throw new Error("402 response has no payTo");
      return checkSeller(payTo, namedAgent(pr, pr.accepts[0].network));
    },

    /** 付款買一個訊號。回傳 HTTP 狀態、內容、付款交易（如果有付），以及付款前的賣方驗證 */
    async buySignal(asset: string) {
      lastSellerCheck = undefined;
      let res: Response;
      try {
        res = await fetchWithPay(`${gateway}/signal/${encodeURIComponent(asset.toUpperCase())}`);
      } catch (e) {
        // 賣方驗證不過 → 沒有簽名、沒有付款
        const sc = lastSellerCheck as SellerVerdict | undefined; // 在 hook 裡被設定
        if (sc && !sc.ok)
          return { status: 0, body: undefined, payment: undefined, paymentExplorer: undefined, needsVerification: false, verifyUrl: "", sellerCheck: sc, refused: true };
        throw e;
      }
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
        sellerCheck: lastSellerCheck,
        refused: false,
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
