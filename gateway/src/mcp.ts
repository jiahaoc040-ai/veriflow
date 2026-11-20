/**
 * VeriFlow MCP server（本機版，stdio，會付款）
 * -----------------------------------------
 * 讓任何 MCP agent（例如 Claude）直接：
 *   get_signal         付款（x402，testnet CCD）買一個 RISK_ON / RISK_OFF 訊號
 *   check_seller       付款前驗證賣方（badge、Registry、Agent Card 雜湊、收款地址＝鏈上 agentWallet）
 *   get_track_record   看命中率（公開）
 *   list_commitments   看所有鏈上承諾（公開）
 *   verify_signal      直接向 Concordium 節點讀回承諾並驗證（不經過賣方的伺服器）；可貼上訊號內容一起驗
 *   check_eligibility  買方帳號是否已通過零知識資格驗證
 * 免費的四個工具與公開版（mcp-http.ts，POST /mcp）共用 mcp-tools.ts。
 *
 * 付款用 BUYER_KEY_FILE 的帳號，花費護欄同示範 buyer（只付 CCD、單次上限 MAX_PAY_MICROCCD）。
 * 執行（stdio）：npm run mcp
 *
 * 注意：stdio 模式下 stdout 是 MCP 通訊管道，任何 console.log 都會弄壞協定，所以全部導到 stderr。
 */
console.log = console.error;

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createBuyerAgent } from "./agent.js";
import { ABOUT, EXPLORER, createChainReader, errText, fail, json, registerPublicTools } from "./mcp-tools.js";

const agent = createBuyerAgent();

const INSTRUCTIONS =
  ABOUT +
  "Typical flow: (1) check_eligibility — the paying account must have passed a one-time zero-knowledge check " +
  "(age >= 18, not resident in a restricted country); if it has not, give the human the verify_url and stop, never try " +
  "to work around it. (2) get_track_record and list_commitments to judge the seller's verifiable history. " +
  "(3) check_seller — before any payment the buyer verifies the seller in Concordium's Agent Registry: identity-verified " +
  "badge, Active, Agent Card hash, and that the x402 payTo is the agent's on-chain wallet; get_signal runs the same check " +
  "itself and refuses to pay if anything fails. (4) get_signal pays about 1 testnet CCD. (5) verify_signal with the " +
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
      return json({ verified: v.ok, ...v, checked_in: "Concordium Agent Registry <12802,0> via agent-registry-mcp.concordium.com" });
    } catch (e) {
      return fail(`Seller check failed: ${errText(e)}`);
    }
  },
);

await server.connect(new StdioServerTransport());
console.error(`veriflow MCP ready (buyer ${agent.address}, gateway ${agent.gateway})`);
