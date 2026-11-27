/**
 * Public MCP (POST /mcp, Streamable HTTP): connects with the official SDK's HTTP client, with a fake seller site
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { mountRemoteMcp } from "../src/mcp-http.ts";

const WALLET = "3WSAJwTZqVRypnGMkUjW28QDES8h1FUBoCwrzQ1rdN35NGavf8";
const C1 = "ab".repeat(32);
let seller: Server;
let hosted: Server;
let mcpUrl = "";
const listen = (s: Server) => new Promise<string>((ok) => s.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(s.address() as { port: number }).port}`)));
const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "");

before(async () => {
  seller = createServer((req, res) => {
    const send = (code: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(code, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.url === "/commitments") return send(200, [{ commitment: C1, asset: "ETH", anchor_tx: null }]);
    if (req.url === `/commitments/${C1}`) return send(200, { commitment: C1, anchor_tx: null });
    if (req.url === "/track-record") return send(200, { issued: 4, signal_days: 2, scored: 0 });
    if (req.url === `/eligibility/${WALLET}`) return send(200, { eligible: true });
    if (req.url === "/signal/BTC") {
      const required = { x402Version: 2, accepts: [{ scheme: "exact", network: "ccd:4221332d34e1694168c2a0c0b3fd0f27", amount: "1000000", asset: "CCD", payTo: WALLET }] };
      return send(402, {}, { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64") });
    }
    send(404, { error: "not_found" });
  });
  const sellerUrl = await listen(seller);
  const app = express();
  app.use(express.json());
  mountRemoteMcp(app, {
    selfUrl: sellerUrl,
    publicUrl: "https://veriflow.example",
    checkSeller: async (url, init, network, payNetwork) => ({ url, method: init.method, redirect: init.redirect, network, payNetwork: payNetwork ?? null, would_pay: false, paid: false }),
  });
  hosted = createServer(app);
  mcpUrl = `${await listen(hosted)}/mcp`;
});

after(() => {
  seller?.close();
  hosted?.close();
});

async function connect() {
  const client = new Client({ name: "remote-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
  return client;
}

test("hosted MCP: read-only tools only — no tool can spend money", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["check_eligibility", "check_seller", "get_track_record", "how_to_buy", "list_commitments", "verify_signal"]);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));
  assert.match(client.getInstructions() ?? "", /never holds anyone's keys/);
  await client.close();
});

test("hosted MCP: free tools answer, and how_to_buy returns the live x402 terms without paying", async () => {
  const client = await connect();
  assert.equal(JSON.parse(text(await client.callTool({ name: "get_track_record", arguments: {} }))).signal_days, 2);
  assert.equal(JSON.parse(text(await client.callTool({ name: "list_commitments", arguments: {} })))[0].commitment, C1);
  assert.equal(JSON.parse(text(await client.callTool({ name: "check_eligibility", arguments: { account: WALLET } }))).eligible, true);
  const buy = JSON.parse(text(await client.callTool({ name: "how_to_buy", arguments: {} })));
  assert.equal(buy.accepts[0].payTo, WALLET);
  assert.equal(buy.endpoint, "https://veriflow.example/signal/{BTC|ETH}");
  const unanchored = await client.callTool({ name: "verify_signal", arguments: { commitment: C1 } });
  assert.equal(unanchored.isError, true);
  await client.close();
});

test("hosted MCP: the account is required (no default paying account on a public server)", async () => {
  const client = await connect();
  const r = await client.callTool({ name: "check_eligibility", arguments: {} });
  assert.equal(r.isError, true);
  await client.close();
});

test("hosted MCP: GET is not allowed (stateless, no SSE stream)", async () => {
  const r = await fetch(mcpUrl);
  assert.equal(r.status, 405);
  assert.equal(r.headers.get("allow"), "POST");
});


test("hosted MCP: check_seller passes the seller URL, network and option to the guard, never follows redirects, pays nothing", async () => {
  const client = await connect();
  const r = JSON.parse(text(await client.callTool({ name: "check_seller", arguments: { url: "https://x402-doctor.fizzl.eu/api/v1/preflight", network: "mainnet", pay_network: "eip155:8453" } })));
  assert.deepEqual(r, { url: "https://x402-doctor.fizzl.eu/api/v1/preflight", method: "GET", redirect: "manual", network: "mainnet", payNetwork: "eip155:8453", would_pay: false, paid: false });
  assert.equal((await client.callTool({ name: "check_seller", arguments: { url: "not a url" } })).isError, true);
  await client.close();
});
