/**
 * Payment tools of the buyer agent (shared by the demo buyer and the MCP server)
 * ----------------------------------------------------
 * Spend controls: pays in one asset only (testnet CCD by default, at most MAX_PAY_MICROCCD per payment, default 2 CCD; or a PLT, or USDC on Base).
 * If the seller asks for more, or for another asset, the agent refuses to pay.
 * Verifies the seller before paying (counterparty.ts): badge, Registry status, Agent Card hash, payTo = on-chain agentWallet;
 * if any check fails, nothing is signed (REQUIRE_SELLER_BADGE=false turns this off for local development).
 */
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactConcordiumScheme } from "@x402/concordium/exact/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { NET } from "./network.js";
import { getExplorerTxUrl } from "@x402/concordium";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { NETWORK, env, loadAccount } from "./config.js";
import { PUBLIC_GATEWAY } from "./mcp-launch.js";
import type { SellerVerdict } from "./counterparty.js";
import { checkSellerFor, summarize, type GuardPolicy, type GuardVerdict, type PaymentRequiredLike, type ReputationMode, type Requirement } from "./guard.js";
import { guardDeps } from "./guard-deps.js";

/** Options override the environment: the live site's demo button uses its own key file, agent id and CCD only */
export function createBuyerAgent(opts: { keyFile?: string; gateway?: string; agentTokenId?: string; ccdOnly?: boolean } = {}) {
  const buyer = loadAccount(opts.keyFile ?? env("BUYER_KEY_FILE"));
  const gateway = opts.gateway ?? env("GATEWAY_URL", PUBLIC_GATEWAY);
  // Which asset to pay in: CCD by default; BUYER_PAY_ASSET=VFUSD (etc.) pays in that Protocol-Level Token (cap BUYER_MAX_PAY, smallest unit)
  // BUYER_PAY_NETWORK=evm: pay in USDC on Base (testnet = Base Sepolia); the EVM key is in BUYER_EVM_KEY_FILE (create with npm run cis8 -- keygen)
  const payEvm = !opts.ccdOnly && (process.env.BUYER_PAY_NETWORK ?? "").trim().toLowerCase() === "evm";
  const payAsset = payEvm ? "USDC" : opts.ccdOnly ? "CCD" : (process.env.BUYER_PAY_ASSET ?? "CCD").trim() || "CCD";
  if (!/^[A-Za-z][A-Za-z0-9-]{1,10}[A-Za-z0-9]$/.test(payAsset)) throw new Error("BUYER_PAY_ASSET must be CCD or a PLT token id");
  // Caps are in the smallest unit: microCCD for CCD; USDC has 6 decimals (default 20000 = 0.02 USDC)
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
  // The buyer's own CIS-8004 agent (optional). The seller checks from a node that the paying account is its agentWallet
  const buyerAgentId = (opts.agentTokenId ?? process.env.BUYER_AGENT_TOKEN_ID ?? "").trim();
  if (buyerAgentId && !/^\d{1,20}$/.test(buyerAgentId)) throw new Error("BUYER_AGENT_TOKEN_ID must be a CIS-8004 token id (digits)");
  const agentHeaders: Record<string, string> = buyerAgentId ? { "X-Concordium-Agent": buyerAgentId } : {};
  let lastSellerCheck: GuardVerdict | undefined;
  // Seller checks are the guard's (guard.ts): the same code any x402 client can wrap around its own payments.
  // This buyer's own policy: pay only sellers that name their agent in the 402; a third party's proven non-delivery also blocks
  const deps = guardDeps();
  // vet402 records testnet deliveries only, so it is off by default on mainnet
  const reputation = env("BUYER_REPUTATION", NET.name === "testnet" ? "block-no" : "off") as ReputationMode;
  if (!["off", "advisory", "block-no", "require-go"].includes(reputation)) throw new Error("BUYER_REPUTATION must be off, advisory, block-no or require-go");
  const policy: GuardPolicy = { requireNamedAgent: true, reputation };
  const checkSeller = (req: Requirement, pr?: PaymentRequiredLike) => checkSellerFor({ origin: gateway, req, paymentRequired: pr }, deps, policy);

  // The last gate before signing: if the seller fails verification, stop here and the wallet is never called
  client.onBeforePaymentCreation(async ({ selectedRequirements, paymentRequired }) => {
    if (!requireSeller) return;
    lastSellerCheck = await checkSeller(selectedRequirements as Requirement, paymentRequired);
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

    /** No payment: see whom the seller wants us to pay, and verify the seller */
    async checkSeller(asset = "BTC"): Promise<SellerVerdict> {
      const res = await fetch(`${gateway}/signal/${encodeURIComponent(asset.toUpperCase())}`);
      const header = res.headers.get("PAYMENT-REQUIRED");
      if (res.status !== 402 || !header) throw new Error(`expected an x402 402 response from ${gateway}, got HTTP ${res.status}`);
      const pr = decodePaymentRequiredHeader(header);
      // Look at payTo for the payment option we would use
      const pick = pr.accepts?.find((a) => a.network === payNetwork) ?? pr.accepts?.[0];
      if (!pick?.payTo) throw new Error("402 response has no payTo");
      return checkSeller(pick as Requirement, pr);
    },

    /** Buy one signal. Returns the HTTP status, body, payment transaction (if paid) and the seller check made before paying */
    async buySignal(asset: string) {
      lastSellerCheck = undefined;
      let res: Response;
      try {
        res = await fetchWithPay(`${gateway}/signal/${encodeURIComponent(asset.toUpperCase())}`, { headers: agentHeaders });
      } catch (e) {
        // Seller failed verification → nothing signed, nothing paid
        const sc = lastSellerCheck as SellerVerdict | undefined; // set in the hook
        if (sc && !sc.ok)
          return { status: 0, body: undefined, payment: undefined, paymentExplorer: undefined, needsVerification: false, verifyUrl: "", sellerCheck: sc, refused: true };
        // The seller offers no option we can pay with (e.g. no USDC yet): say so plainly instead of a long raw error
        if (/No network\/scheme registered/.test(String(e)))
          throw new Error(`the seller does not offer ${payAsset} on ${payNetwork}; nothing was signed or paid`);
        throw e;
      }
      const text = await res.text();
      let body: unknown = text;
      try { body = JSON.parse(text); } catch { /* keep the raw text if it is not JSON */ }
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

    /** Public endpoints that need no payment */
    async get(path: string) {
      const res = await fetch(`${gateway}${path}`);
      if (!res.ok) throw new Error(`${path} → HTTP ${res.status}: ${await res.text()}`);
      return res.json();
    },
  };
}
