/**
 * 公開版 MCP（Streamable HTTP，POST /mcp）——不用安裝，任何 MCP 客戶端貼網址就能用
 * --------------------------------------------------------------------------
 * 只有免費工具與購買說明：付款要用買方自己的錢包，公開伺服器不碰任何人的金鑰。
 *   get_track_record / list_commitments / verify_signal / check_eligibility（與本機版共用 mcp-tools.ts）
 *   how_to_buy：不付款，回傳 x402 的付款條件（付給誰、多少、需要什麼證明）與購買方式
 *
 * 無狀態（每個請求一個 server），不需要 session。
 * verify_signal 在這裡是「VeriFlow 的伺服器去讀 Concordium」；要完全不信任我們，用本機版或公開儀表板（瀏覽器自己算）。
 */
import type { Express, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ABOUT, createChainReader, errText, fail, json, publicOps, registerPublicTools, type PublicApi } from "./mcp-tools.js";

export const REMOTE_INSTRUCTIONS =
  ABOUT +
  "This is VeriFlow's hosted, read-only MCP endpoint: judge the seller with get_track_record and list_commitments, " +
  "check a commitment on-chain with verify_signal, check a buyer account with check_eligibility, and call how_to_buy " +
  "for the x402 payment terms. Buying needs the buyer's own wallet, so payment happens in the buyer's own agent " +
  "(VeriFlow's local MCP server or any x402 client); this server never holds anyone's keys. For a check that does not " +
  "rely on VeriFlow at all, verify in the buyer's own agent or the public dashboard. Not investment advice.";

export function mountRemoteMcp(app: Express, opts: { selfUrl: string; publicUrl: string }) {
  const api: PublicApi = {
    gateway: opts.publicUrl,
    async get(path) {
      const r = await fetch(`${opts.selfUrl}${path}`);
      if (!r.ok) throw new Error(`${path} → HTTP ${r.status}: ${await r.text()}`);
      return r.json();
    },
  };
  const readSettled = createChainReader(api, "read by VeriFlow's hosted MCP server (for a check independent of VeriFlow, run the local MCP server or the public dashboard)");

  function build() {
    const server = new McpServer({ name: "veriflow-hosted", version: "0.3.0" }, { instructions: REMOTE_INSTRUCTIONS });
    registerPublicTools(server, api, readSettled);
    const ops = publicOps(api, readSettled);
    server.registerTool(
      "how_to_buy",
      {
        title: "How to buy a VeriFlow signal",
        description:
          "Without paying: the x402 payment terms VeriFlow asks for (network, asset, amount, payTo, required buyer proof) " +
          "and how a buyer agent pays with its own wallet.",
        inputSchema: {},
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async () => {
        try {
          return json(await ops.howToBuy(opts.selfUrl));
        } catch (e) {
          return fail(errText(e));
        }
      },
    );
    return server;
  }

  app.post("/mcp", async (req: Request, res: Response) => {
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: errText(e) }, id: null });
    }
  });
  // 無狀態：不提供 SSE 串流與 session 結束
  const notAllowed = (_req: Request, res: Response) =>
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: POST JSON-RPC to /mcp" }, id: null });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
}
