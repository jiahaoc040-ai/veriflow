/**
 * Payment tools of the buyer agent (shared by the demo buyer and the MCP server)
 * ----------------------------------------------------
 * Spend controls: pays in one asset only (testnet CCD by default, at most MAX_PAY_MICROCCD per payment, default 2 CCD; or a PLT, or USDC on Base).
 * If the seller asks for more, or for another asset, the agent refuses to pay.
 * Verifies the seller before paying (counterparty.ts): badge, Registry status, Agent Card hash, payTo = on-chain agentWallet;
 * if any check fails, nothing is signed (REQUIRE_SELLER_BADGE=false turns this off for local development).
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
  // Which asset to pay in: CCD by default; BUYER_PAY_ASSET=VFUSD (etc.) pays in that Protocol-Level Token (cap BUYER_MAX_PAY, smallest unit)
  // BUYER_PAY_NETWORK=evm: pay in USDC on Base (testnet = Base Sepolia); the EVM key is in BUYER_EVM_KEY_FILE (create with npm run cis8 -- keygen)
  const payEvm = (process.env.BUYER_PAY_NETWORK ?? "").trim().toLowerCase() === "evm";
  const payAsset = payEvm ? "USDC" : (process.env.BUYER_PAY_ASSET ?? "CCD").trim() || "CCD";
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
  const buyerAgentId = (process.env.BUYER_AGENT_TOKEN_ID ?? "").trim();
  if (buyerAgentId && !/^\d{1,20}$/.test(buyerAgentId)) throw new Error("BUYER_AGENT_TOKEN_ID must be a CIS-8004 token id (digits)");
  const agentHeaders: Record<string, string> = buyerAgentId ? { "X-Concordium-Agent": buyerAgentId } : {};
  let lastSellerCheck: SellerVerdict | undefined;
  /** The 402's concordium-agent extension only names the agent (registry, token id); the wallet is always read from the chain. A wrong network or registry counts as not named */
  // The named agent always lives on Concordium: when paying on EVM compare against the Concordium network, otherwise against the chosen payment network
  const namedAgent = (pr: { extensions?: Record<string, unknown> } | undefined, payNet: string) => {
    const network = isEvmNetwork(payNet) ? NETWORK : payNet;
    const info = (pr?.extensions?.[AGENT_EXTENSION] as { info?: { network?: string; registry?: string; tokenId?: string; badge?: string } } | undefined)?.info;
    // This buyer pays only sellers that name themselves: no name, no payment (the protocol allows it, this buyer's policy does not)
    if (!info) return "unnamed";
    if (info.network !== network || info.registry !== `${AGENT_REGISTRY.index}.${AGENT_REGISTRY.subindex}` || !/^\d+$/.test(info.tokenId ?? ""))
      return "mismatch";
    return `${info.tokenId}|${info.badge ?? ""}`;
  };
  /**
   * EVM payTo: the 402's extra.cis8 gives the seller's public key. The buyer reads CIS-8 from a Concordium node itself and requires
   * the address derived from the key to equal payTo, the binding to be Active, and the owner to be this agent's owner (or its agentWallet)
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

  // The last gate before signing: if the seller fails verification, stop here and the wallet is never called
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

    /** No payment: see whom the seller wants us to pay, and verify the seller */
    async checkSeller(asset = "BTC"): Promise<SellerVerdict> {
      const res = await fetch(`${gateway}/signal/${encodeURIComponent(asset.toUpperCase())}`);
      const header = res.headers.get("PAYMENT-REQUIRED");
      if (res.status !== 402 || !header) throw new Error(`expected an x402 402 response from ${gateway}, got HTTP ${res.status}`);
      const pr = decodePaymentRequiredHeader(header);
      // Look at payTo for the payment option we would use
      const pick = pr.accepts?.find((a) => a.network === payNetwork) ?? pr.accepts?.[0];
      if (!pick?.payTo) throw new Error("402 response has no payTo");
      return checkSeller(pick.payTo, namedAgent(pr, pick.network), pick as { network: string; payTo: string; extra?: Record<string, unknown> });
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
