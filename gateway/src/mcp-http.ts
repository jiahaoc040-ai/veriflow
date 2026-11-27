/**
 * Public MCP (Streamable HTTP, POST /mcp) — nothing to install; any MCP client can use the URL
 * --------------------------------------------------------------------------
 * Free tools and buying instructions only: paying needs the buyer's own wallet, and the public server touches nobody's keys.
 *   get_track_record / list_commitments / verify_signal / check_eligibility (shared with the local version through mcp-tools.ts)
 *   how_to_buy: no payment; returns the x402 terms (whom to pay, how much, what proof) and how to buy
 *
 * Stateless (one server per request), no session.
 * Here verify_signal means VeriFlow's server reads Concordium; to trust us not at all, use the local version or the public dashboard (the browser computes itself).
 */
import type { Express, Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { ABOUT, createChainReader, errText, fail, json, publicOps, registerPublicTools, type PublicApi } from "./mcp-tools.js";

export const REMOTE_INSTRUCTIONS =
  ABOUT +
  "This is VeriFlow's hosted, read-only MCP endpoint. Before paying ANY x402 seller, call check_seller with its URL: it checks that seller " +
  "on Concordium (testnet or mainnet) the way a paying agent's guard would, and pays nothing. For VeriFlow's own signal: judge the seller with get_track_record and list_commitments, " +
  "check a commitment on-chain with verify_signal, check a buyer account with check_eligibility, and call how_to_buy " +
  "for the x402 payment terms. Buying needs the buyer's own wallet, so payment happens in the buyer's own agent " +
  "(VeriFlow's local MCP server or any x402 client); this server never holds anyone's keys. For a check that does not " +
  "rely on VeriFlow at all, verify in the buyer's own agent or the public dashboard. Not investment advice.";

/** Runs the buyer's guard on a seller URL for the hosted check_seller tool (gateway.ts wires testnet and mainnet) */
export type SellerCheck = (url: string, init: RequestInit, network: "testnet" | "mainnet", payNetwork?: string) => Promise<unknown>;

export function mountRemoteMcp(app: Express, opts: { selfUrl: string; publicUrl: string; checkSeller?: SellerCheck }) {
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
    const server = new McpServer({ name: "veriflow-hosted", version: "0.4.0" }, { instructions: REMOTE_INSTRUCTIONS });
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
    if (opts.checkSeller) {
      const check = opts.checkSeller;
      server.registerTool(
        "check_seller",
        {
          title: "Check an x402 seller on Concordium before paying it",
          description:
            "Without paying and without a wallet: reads any x402 seller's 402 answer and checks that seller on Concordium, as a paying agent's guard " +
            "would (concordium-x402-guard): an Active agent in the CIS-8004 Agent Registry, the official badge check, the Agent Card unchanged since " +
            "its SHA-256 was pinned on-chain, and payTo = the agent's own on-chain agentWallet (on Base: a key bound to its owner in CIS-8). " +
            "Returns each check and whether the guard would pay. testnet or mainnet.",
          inputSchema: {
            url: z.string().url().max(500).describe("The seller's paid x402 URL (https, public host)"),
            network: z.enum(["testnet", "mainnet"]).default("testnet").describe("Concordium network the seller's agent is registered on"),
            method: z.enum(["GET", "POST"]).default("GET"),
            body: z.string().max(4000).optional().describe("JSON body, for a POST"),
            pay_network: z.string().max(80).optional().describe("Which payment option to check, as CAIP-2 (e.g. eip155:8453 for Base); default the Concordium one"),
          },
          annotations: { readOnlyHint: true, openWorldHint: true },
        },
        async ({ url, network, method, body, pay_network }) => {
          try {
            const init: RequestInit = { method, redirect: "manual", ...(body ? { body, headers: { "content-type": "application/json" } } : {}) };
            return json(await check(url, init, network, pay_network));
          } catch (e) {
            return fail(errText(e));
          }
        },
      );
    }
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
      console.error("mcp:", e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
    }
  });
  // Stateless: no SSE stream and no session termination
  const notAllowed = (_req: Request, res: Response) =>
    res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: POST JSON-RPC to /mcp" }, id: null });
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
}
