/**
 * VeriFlow MCP server (local, stdio, can pay)
 * -----------------------------------------
 * Lets any MCP agent (e.g. Claude) directly:
 *   get_signal         pay (x402, testnet CCD) for a RISK_ON / RISK_OFF call
 *   check_seller       verify the seller before paying (badge, Registry, Agent Card hash, payout address = on-chain agentWallet)
 *   check_any_seller   the same checks on ANY x402 seller URL, without paying (guard.ts), e.g. another team's agent
 *   get_track_record   public counts of the record (no hit rate)
 *   list_commitments   all on-chain commitments (public)
 *   verify_signal      read a commitment straight from a Concordium node and verify it (not through the seller's server); optionally with the signal text
 *   check_eligibility  whether a buyer account has passed the zero-knowledge eligibility check
 * The four free tools are shared with the public version (mcp-http.ts, POST /mcp) through mcp-tools.ts.
 *
 * Pays from the BUYER_KEY_FILE account, with the demo buyer's spend controls (one asset, per-payment cap MAX_PAY_MICROCCD).
 * Run (stdio): npm run mcp
 *
 * Note: in stdio mode stdout is the MCP channel and any console.log would break the protocol, so all logging goes to stderr.
 */
console.log = console.error;

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createBuyerAgent } from "./agent.js";
import { checkSellerAt, summarize } from "./guard.js";
import { guardDeps } from "./guard-deps.js";
import { AGENT_REGISTRY_TEXT } from "./registry-node.js";
import { ABOUT, EXPLORER, createChainReader, errText, fail, json, registerPublicTools } from "./mcp-tools.js";

const agent = createBuyerAgent();

const INSTRUCTIONS =
  ABOUT +
  "Typical flow: (1) check_eligibility — the paying account must have passed a one-time zero-knowledge check " +
  "(age >= 18, not resident in a restricted country); if it has not, give the human the verify_url and stop, never try " +
  "to work around it. (2) get_track_record and list_commitments to judge the seller's verifiable history. " +
  "(3) check_seller — before any payment the buyer verifies the seller in Concordium's Agent Registry: identity-verified " +
  "badge, Active, Agent Card hash, and that the x402 payTo is the agent's on-chain wallet; get_signal runs the same check " +
  "itself and refuses to pay if anything fails. To check any other x402 seller (not VeriFlow) before paying it, use check_any_seller. (4) get_signal pays about 1 testnet CCD. (5) verify_signal with the " +
  "returned commitment and canonical string: it reads the anchor straight from a Concordium node, so you do not have to " +
  "trust VeriFlow's server. Payments are Concordium testnet CCD only. Not investment advice.";

const server = new McpServer({ name: "veriflow", version: "0.3.0" }, { instructions: INSTRUCTIONS });
const readSettled = createChainReader(agent, "read directly by this buyer agent, VeriFlow's server is not involved");
registerPublicTools(server, agent, readSettled, agent.address);

server.registerTool(
  "get_signal",
  {
    title: "Buy a VeriFlow signal",
    description:
      "Pay (x402, Concordium testnet CCD) for the latest risk-regime signal (RISK_ON / RISK_OFF) for BTC or ETH. " +
      "The signal's SHA-256 commitment is anchored on Concordium before the outcome is known. " +
      `Costs about 1 CCD; the agent refuses to pay more than ${Number(agent.maxPayMicroCcd) / 1e6} CCD. Not investment advice.`,
    inputSchema: { asset: z.enum(["BTC", "ETH"]).describe("Asset to get the signal for") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  async ({ asset }) => {
    try {
      const r = await agent.buySignal(asset);
      if (r.refused)
        return { ...json({ paid: false, reason: "The seller failed verification, so nothing was signed or paid.", seller_check: r.sellerCheck }), isError: true };
      if (r.needsVerification)
        return fail(
          `The buyer account ${agent.address} has not proven eligibility (age ≥ 18, not in a restricted country). ` +
            `A human must verify once with the Concordium wallet at ${r.verifyUrl}. No payment was taken.`,
        );
      if (r.status !== 200) return fail(`Gateway returned HTTP ${r.status}: ${JSON.stringify(r.body)}`);
      const b = r.body as Record<string, unknown>;
      return json({
        ...b,
        paid_by: agent.address,
        payment_tx: r.payment?.transaction,
        payment_explorer: r.paymentExplorer,
        anchor_explorer: b.anchor_tx ? EXPLORER + b.anchor_tx : undefined,
        seller_check: r.sellerCheck,
        how_to_verify: "Call verify_signal with this commitment and canonical string.",
      });
    } catch (e) {
      return fail(`Could not buy signal: ${errText(e)}`);
    }
  },
);

server.registerTool(
  "check_seller",
  {
    title: "Verify the seller before paying",
    description:
      "Without paying, ask VeriFlow's x402 endpoint whom it wants to be paid, then check that seller in Concordium's Agent " +
      "Registry (CIS-8004): Verified by Concordium badge (identity-verified owner), Active, Agent Card unchanged since it was " +
      "pinned on-chain (hash computed here), and payTo equal to the agent's on-chain wallet. get_signal runs this same check " +
      "automatically and refuses to pay if any item fails.",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async () => {
    try {
      const v = await agent.checkSeller();
      return json({ verified: v.ok, ...v, checked_in: `Concordium Agent Registry ${AGENT_REGISTRY_TEXT}, read from a node; badge via agent-registry-mcp.concordium.com` });
    } catch (e) {
      return fail(`Seller check failed: ${errText(e)}`);
    }
  },
);

server.registerTool(
  "check_any_seller",
  {
    title: "Check any x402 seller before paying",
    description:
      "Without paying, call any x402 endpoint (not only VeriFlow's), read whom it wants to be paid, and check that seller on " +
      "Concordium: Verified by Concordium badge on its site, registered and Active in the CIS-8004 Agent Registry (read from a " +
      "node), official badge check, Agent Card hash, and payTo equal to the agent's on-chain wallet (or, for an EVM payTo, a key " +
      "bound to the agent's owner in CIS-8); plus, on testnet, another team's independent delivery record (vet402). Use it before " +
      "paying any agent. Example: https://mainsmarker.sites.tab.bot/x402/review with method POST and a JSON body.",
    inputSchema: {
      url: z.string().url().describe("The paid x402 endpoint (https)"),
      method: z.enum(["GET", "POST"]).optional().describe("HTTP method the endpoint expects (default GET, or POST when json is given)"),
      json: z.string().max(8000).optional().describe("JSON request body, as a string, for endpoints that need one"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ url, method, json: body }) => {
    try {
      if (!/^https:\/\//.test(url)) return fail("Only https URLs are checked.");
      const init: RequestInit = { method: method ?? (body ? "POST" : "GET"), ...(body ? { body, headers: { "content-type": "application/json" } } : {}) };
      const { verdict, options, picked } = await checkSellerAt(url, init, guardDeps());
      return json({ pay_or_not: verdict.ok ? "checks pass: OK to pay" : "do not pay", summary: summarize(verdict), picked_option: picked, all_options: options, ...verdict });
    } catch (e) {
      return fail(`Seller check failed: ${errText(e)}`);
    }
  },
);

await server.connect(new StdioServerTransport());
console.error(`veriflow MCP ready (buyer ${agent.address}, gateway ${agent.gateway})`);
