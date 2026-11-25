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
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { NET } from "./network.js";
import { checkEvmBinding, EVM_KEY_TYPE, CIS8_REGISTRY } from "./cis8.js";
import { isEvmNetwork } from "./evm-payer.js";
import { sameAccount } from "./contract-v2.js";
import { getExplorerTxUrl } from "@x402/concordium";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { NETWORK, env, loadAccount } from "./config.js";
import { PUBLIC_GATEWAY } from "./mcp-launch.js";
import { summarize, verifySeller, type SellerVerdict } from "./counterparty.js";
import { REGISTRY_NETWORK, registryTool } from "./registry.js";

export function createBuyerAgent() {
  const buyer = loadAccount(env("BUYER_KEY_FILE"));
  const gateway = env("GATEWAY_URL", PUBLIC_GATEWAY);
  // 用哪一種資產付款：預設 CCD；設 BUYER_PAY_ASSET=VFUSD 之類就用那個 Protocol-Level Token（上限 BUYER_MAX_PAY，最小單位）
  // BUYER_PAY_NETWORK=evm：改用 Base（testnet＝Base Sepolia）上的 USDC 付款，EVM 金鑰在 BUYER_EVM_KEY_FILE（npm run cis8 -- keygen 產生）
  const payEvm = (process.env.BUYER_PAY_NETWORK ?? "").trim().toLowerCase() === "evm";
  const payAsset = payEvm ? "USDC" : (process.env.BUYER_PAY_ASSET ?? "CCD").trim() || "CCD";
  if (!/^[A-Za-z][A-Za-z0-9-]{1,10}[A-Za-z0-9]$/.test(payAsset)) throw new Error("BUYER_PAY_ASSET must be CCD or a PLT token id");
  // 上限都是最小單位：CCD 是 microCCD；USDC 6 位小數（預設 20000＝0.02 USDC）
  const maxPay = payEvm ? env("BUYER_MAX_PAY", "20000") : payAsset === "CCD" ? env("MAX_PAY_MICROCCD", "2000000") : env("BUYER_MAX_PAY", "2000000");
  const payNetwork = payEvm ? NET.evm.network : NETWORK;
  const evmKey = payEvm ? (JSON.parse(readFileSync(env("BUYER_EVM_KEY_FILE", "keys/evm-buyer.json"), "utf8")) as { privateKey: `0x${string}` }) : undefined;
  const evmAccount = evmKey ? privateKeyToAccount(evmKey.privateKey) : undefined;
  const client = x402Client.fromConfig({
    schemes: [
      evmAccount
        ? { network: payNetwork as `${string}:${string}`, client: new ExactEvmScheme(evmAccount) }
        : { network: NETWORK, client: new ExactConcordiumScheme({ accountAddress: buyer.accountAddress, signer: buyer.signer }) },
    ],
    spendControls: { allowedAssets: [{ network: payNetwork, asset: payAsset, maxAmountPerPayment: maxPay }] },
  });
  const requireSeller = env("REQUIRE_SELLER_BADGE", "true") !== "false";
  // 買方自己在 CIS-8004 登記的 agent（選填）。賣方會從節點確認付款帳號就是它的 agentWallet
  const buyerAgentId = (process.env.BUYER_AGENT_TOKEN_ID ?? "").trim();
  if (buyerAgentId && !/^\d{1,20}$/.test(buyerAgentId)) throw new Error("BUYER_AGENT_TOKEN_ID must be a CIS-8004 token id (digits)");
  const agentHeaders: Record<string, string> = buyerAgentId ? { "X-Concordium-Agent": buyerAgentId } : {};
  let lastSellerCheck: SellerVerdict | undefined;
  /** 402 的 concordium-agent 擴充欄位：只是指名（registry、token id），錢包一律從鏈上讀；網路或 registry 不對就當作沒指名 */
  // 指名的 agent 一定在 Concordium 上；用 EVM 付款時拿 Concordium 網路比對，否則比對所選付款方式的網路
  const namedAgent = (pr: { extensions?: Record<string, unknown> } | undefined, payNet: string) => {
    const network = isEvmNetwork(payNet) ? NETWORK : payNet;
    const info = (pr?.extensions?.[AGENT_EXTENSION] as { info?: { network?: string; registry?: string; tokenId?: string; badge?: string } } | undefined)?.info;
    // 這個買方只付給「有指名自己」的賣方：沒有指名就拒絕（協定允許不指名，買方的政策不允許）
    if (!info) return "unnamed";
    if (info.network !== network || info.registry !== `${AGENT_REGISTRY.index}.${AGENT_REGISTRY.subindex}` || !/^\d+$/.test(info.tokenId ?? ""))
      return "mismatch";
    return `${info.tokenId}|${info.badge ?? ""}`;
  };
  /**
   * EVM 收款地址：402 的 extra.cis8 給出賣方的公鑰。買方自己從 Concordium 節點讀 CIS-8，
   * 要求公鑰推出的地址＝payTo、綁定是 Active，而且綁在這個 agent 的擁有者（或它的 agentWallet）底下
   */
  const cis8PayTo = (req: { network: string; payTo: string; extra?: Record<string, unknown> }) => async (agent: { owner?: string; wallet?: string }) => {
    const name = "payTo is bound to the agent in CIS-8 (read from a Concordium node)";
    const c = req.extra?.cis8 as { registry?: string; namespace?: string; keyType?: string; publicKey?: string } | undefined;
    if (!c?.publicKey) return { name, ok: false, detail: "the 402 offers an EVM payTo without a cis8 public key" };
    if (c.registry !== `${CIS8_REGISTRY.index}.${CIS8_REGISTRY.subindex}` || c.namespace !== req.network || c.keyType !== EVM_KEY_TYPE)
      return { name, ok: false, detail: `unexpected cis8 registry/namespace/key type: ${c.registry} ${c.namespace} ${c.keyType}` };
    const read = (expectOwner: string) => checkEvmBinding({ address: req.payTo, publicKey: c.publicKey!, namespace: req.network, expectOwner }, sameAccount);
    let r = agent.owner ? await read(agent.owner) : { ok: false as const, reason: "agent has no owner on-chain" };
    if (!r.ok && agent.wallet && /is bound to/.test(r.reason)) r = await read(agent.wallet);
    return { name, ok: r.ok, detail: r.ok ? `${req.payTo} is bound to ${r.owner} in CIS-8 <${CIS8_REGISTRY.index},${CIS8_REGISTRY.subindex}>` : r.reason };
  };
  const checkSeller = async (payTo: string, named?: string, req?: { network: string; payTo: string; extra?: Record<string, unknown> }) =>
    named === "mismatch" || named === "unnamed"
      ? {
          ok: false,
          checks: [
            {
              name: "402 names an agent on this network's registry",
              ok: false,
              detail: named === "unnamed" ? "the 402 has no concordium-agent extension: the seller does not name itself" : "concordium-agent extension names another network or registry",
            },
          ],
          payTo,
        }
      : verifySeller({
          gateway,
          payTo,
          registry: registryTool,
          network: REGISTRY_NETWORK,
          readAgent: (id) => readAgent(id),
          expectTokenId: named?.split("|")[0],
          expectBadge: named?.split("|")[1] || undefined,
          payToCheck: req && isEvmNetwork(req.network) ? cis8PayTo(req) : undefined,
        });

  // 簽名之前的最後一道關卡：賣方驗證不過就中止，錢包根本不會被叫到
  client.onBeforePaymentCreation(async ({ selectedRequirements, paymentRequired }) => {
    if (!requireSeller) return;
    lastSellerCheck = await checkSeller(selectedRequirements.payTo, namedAgent(paymentRequired, selectedRequirements.network), selectedRequirements as { network: string; payTo: string; extra?: Record<string, unknown> });
    if (!lastSellerCheck.ok) return { abort: true as const, reason: summarize(lastSellerCheck) };
  });
  const fetchWithPay = wrapFetchWithPayment(fetch, client);

  return {
    address: buyer.address,
    evmAddress: evmAccount?.address,
    payNetwork,
    agentTokenId: buyerAgentId || undefined,
    payAsset,
    gateway,
    maxPayMicroCcd: maxPay,

    /** 不付款，只看賣方要我們付給誰，並驗證賣方 */
    async checkSeller(asset = "BTC"): Promise<SellerVerdict> {
      const res = await fetch(`${gateway}/signal/${encodeURIComponent(asset.toUpperCase())}`);
      const header = res.headers.get("PAYMENT-REQUIRED");
      if (res.status !== 402 || !header) throw new Error(`expected an x402 402 response from ${gateway}, got HTTP ${res.status}`);
      const pr = decodePaymentRequiredHeader(header);
      // 看「我會用的那一種付款方式」的 payTo
      const pick = pr.accepts?.find((a) => a.network === payNetwork) ?? pr.accepts?.[0];
      if (!pick?.payTo) throw new Error("402 response has no payTo");
      return checkSeller(pick.payTo, namedAgent(pr, pick.network), pick as { network: string; payTo: string; extra?: Record<string, unknown> });
    },

    /** 付款買一個訊號。回傳 HTTP 狀態、內容、付款交易（如果有付），以及付款前的賣方驗證 */
    async buySignal(asset: string) {
      lastSellerCheck = undefined;
      let res: Response;
      try {
        res = await fetchWithPay(`${gateway}/signal/${encodeURIComponent(asset.toUpperCase())}`, { headers: agentHeaders });
      } catch (e) {
        // 賣方驗證不過 → 沒有簽名、沒有付款
        const sc = lastSellerCheck as SellerVerdict | undefined; // 在 hook 裡被設定
        if (sc && !sc.ok)
          return { status: 0, body: undefined, payment: undefined, paymentExplorer: undefined, needsVerification: false, verifyUrl: "", sellerCheck: sc, refused: true };
        // 賣方沒有提供我們能付的方式（例如還沒開 USDC）：講清楚，不丟一大段原始錯誤
        if (/No network\/scheme registered/.test(String(e)))
          throw new Error(`the seller does not offer ${payAsset} on ${payNetwork}; nothing was signed or paid`);
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
        paymentExplorer: payment?.transaction ? (payEvm ? `${NET.evm.explorer}/tx/${payment.transaction}` : getExplorerTxUrl(NETWORK, payment.transaction)) : undefined,
        needsVerification: !res.ok && text.includes("buyer_proof_required"),
        buyerAgentRefused: !res.ok && text.includes("buyer_agent_check_failed"),
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
