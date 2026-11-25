/**
 * MCP server integration test: starts it exactly the way Claude Desktop does (the command mcpServerEntry produces),
 * from the root directory with a minimal environment, then talks to it over stdio.
 * The seller site is a local fake server: no network, no payment.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { claudeConfigPath, claudeLogDir, mcpServerEntry, mergeConfig, SERVER_NAME } from "../src/mcp-launch.ts";

const BUYER = "2xBpaHottqhwFZURMZW4uZduQvpxNDSy46iXMYs9kceNGaPpZX"; // test address
const C1 = "ab".repeat(32);
const TOKEN = "JyP9UWYKh54TD2MUJDfqC";
const SELLER_WALLET = "3WSAJwTZqVRypnGMkUjW28QDES8h1FUBoCwrzQ1rdN35NGavf8";
const CARD = JSON.stringify({
  name: "VeriFlow",
  capabilities: { extensions: [{ uri: "https://docs.concordium.com/a2a-extensions/concordium-badge/v1", params: { tokenAddress: `ccd:x/cis-2:${TOKEN}` } }] },
});
const COMMITMENTS = [{ commitment: C1, asset: "BTC", as_of: "2026-11-19", issued_at: "2026-11-20T05:00:42+00:00", anchor_tx: null }];

let http: Server;
let gateway = "";
let client: Client;
let stderr = "";
const protocolErrors: Error[] = [];

/** Fake seller site: answers only the endpoints the free MCP tools call */
function fakeGateway(): Promise<string> {
  http = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? "";
    if (url === "/.well-known/agent-card.json" || url === "/card.json") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(CARD);
    }
    if (url === "/signal/BTC") {
      // Unpaid: x402's 402, with the PAYMENT-REQUIRED header saying whom to pay
      const required = {
        x402Version: 2,
        accepts: [{ scheme: "exact", network: "ccd:test", amount: "1000000", asset: "CCD", payTo: SELLER_WALLET }],
        extensions: { "concordium-agent": { info: { network: "ccd:test", registry: "12802.0", badge: TOKEN, tokenId: "1313" } } },
      };
      res.writeHead(402, { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(required)).toString("base64") });
      return res.end("{}");
    }
    if (url === "/mcp" && req.method === "POST") {
      // Fake Concordium Agent Registry MCP
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const { id, params } = JSON.parse(body);
        const result =
          params.name === "agent_by_token_address"
            ? { token_id: "1313", owner_account: "4dNM", agent_uri: `${gateway}/card.json`, metadata_hash_hex: createHash("sha256").update(CARD).digest("hex"), agent_wallet: SELLER_WALLET, status: "Active" }
            : { badge_valid: true, checks: { status_active: true }, issues: [] };
        send(200, { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], isError: false } });
      });
      return;
    }
    if (url === "/commitments") return send(200, COMMITMENTS);
    if (url === "/track-record") return send(200, { n: 0, hit_rate: null, horizon_days: 7 });
    if (url === `/eligibility/${BUYER}`) return send(200, { eligible: false, policy: { minAge: 18 } });
    if (url === `/commitments/${C1}`) return send(200, { ...COMMITMENTS[0], revealed: false });
    send(404, { error: "not found" });
  });
  return new Promise((ok) => http.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(http.address() as { port: number }).port}`)));
}

/** A well-formed one-off test key with no funds (never signs a transaction) */
function throwawayKeyFile(): string {
  const hex = (n: number) => randomBytes(n).toString("hex");
  const wallet = {
    type: "concordium-browser-wallet-account",
    v: 0,
    environment: "testnet",
    value: {
      accountKeys: { keys: { "0": { keys: { "0": { signKey: hex(32), verifyKey: hex(32) } }, threshold: 1 } }, threshold: 1 },
      credentials: { "0": "00" },
      address: BUYER,
    },
  };
  const file = join(mkdtempSync(join(tmpdir(), "veriflow-mcp-")), "buyer.export");
  writeFileSync(file, JSON.stringify(wallet));
  return file;
}

const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0]?.text ?? "");

before(async () => {
  gateway = await fakeGateway();
  const entry = mcpServerEntry(gateway);
  const transport = new StdioClientTransport({
    command: entry.command,
    args: entry.args,
    env: {
      ...entry.env,
      BUYER_KEY_FILE: throwawayKeyFile(),
      REGISTRY_MCP_URL: `${gateway}/mcp`,
      // Fake node record, consistent with the fake hosted service (in production it is read straight from a Concordium node)
      VERIFLOW_TEST_AGENT_RECORD: JSON.stringify({ tokenId: "1313", owner: "4dNM", agentUri: `${gateway}/card.json`, metadataHash: createHash("sha256").update(CARD).digest("hex"), wallet: SELLER_WALLET, status: "Active" }),
    }, // the SDK adds only HOME, PATH and a few other variables, like Claude Desktop
    cwd: "/", // Claude Desktop does not start us inside the project folder
    stderr: "pipe",
  });
  transport.stderr?.on("data", (d) => (stderr += String(d)));
  client = new Client({ name: "veriflow-test", version: "0.0.0" });
  client.onerror = (e) => protocolErrors.push(e);
  await client.connect(transport);
});

after(async () => {
  await client?.close();
  http?.close();
});

test("launch command: absolute node + tsx loader URL + absolute mcp.ts, public gateway in env", () => {
  const e = mcpServerEntry("https://example.test");
  assert.equal(e.command, process.execPath);
  assert.equal(e.args[0], "--import");
  assert.match(e.args[1], /^file:\/\/.*\/tsx\/dist\/loader\.mjs$/);
  assert.match(e.args[2], /src[\\/]mcp\.ts$/);
  assert.deepEqual(e.env, { GATEWAY_URL: "https://example.test" });
  assert.ok(!JSON.stringify(e).includes("signKey"), "no key material in the config");
});

test("server starts from / with a minimal environment and lists the 6 tools with safety hints", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["check_eligibility", "check_seller", "get_signal", "get_track_record", "list_commitments", "verify_signal"]);
  for (const t of tools) assert.equal(t.annotations?.readOnlyHint, t.name !== "get_signal", t.name);
  assert.match(client.getInstructions() ?? "", /zero-knowledge/);
  assert.ok(stderr.includes(`veriflow MCP ready (buyer ${BUYER}, gateway ${gateway})`), stderr);
});

test("free tools answer from the seller's public endpoints", async () => {
  assert.deepEqual(JSON.parse(text(await client.callTool({ name: "list_commitments", arguments: {} }))), COMMITMENTS);
  assert.equal(JSON.parse(text(await client.callTool({ name: "get_track_record", arguments: {} }))).horizon_days, 7);
  const elig = JSON.parse(text(await client.callTool({ name: "check_eligibility", arguments: {} })));
  assert.equal(elig.account, BUYER);
  assert.equal(elig.eligible, false);
  assert.equal(elig.verify_url, `${gateway}/verify?account=${BUYER}`);
});

test("check_seller: asks the x402 endpoint whom to pay, then verifies that seller in the Agent Registry", async () => {
  const v = JSON.parse(text(await client.callTool({ name: "check_seller", arguments: {} })));
  assert.equal(v.verified, true, JSON.stringify(v.checks));
  assert.equal(v.payTo, SELLER_WALLET);
  assert.equal(v.tokenAddress, TOKEN);
  assert.equal(v.checks.length, 5);
});

test("errors come back as tool errors, not crashes", async () => {
  const unanchored = await client.callTool({ name: "verify_signal", arguments: { commitment: C1 } });
  assert.equal(unanchored.isError, true);
  assert.match(text(unanchored), /not been anchored/);
  const unknown = await client.callTool({ name: "verify_signal", arguments: { commitment: "cd".repeat(32) } });
  assert.equal(unknown.isError, true);
  assert.match(text(unknown), /404/);
  // The server is still alive
  assert.equal((await client.listTools()).tools.length, 6);
});

test("stdout carries only MCP messages (nothing printed into the protocol stream)", () => {
  assert.deepEqual(protocolErrors.map(String), []);
});

test("Claude Desktop config location and log folder per OS", () => {
  assert.equal(
    claudeConfigPath("darwin", {}, "/Users/ss"),
    "/Users/ss/Library/Application Support/Claude/claude_desktop_config.json",
  );
  assert.equal(
    claudeConfigPath("win32", { APPDATA: "C:\\Users\\ss\\AppData\\Roaming" }, "C:\\Users\\ss"),
    "C:\\Users\\ss\\AppData\\Roaming\\Claude\\claude_desktop_config.json",
  );
  assert.equal(claudeConfigPath("linux", {}, "/home/ss"), "/home/ss/.config/Claude/claude_desktop_config.json");
  assert.equal(claudeLogDir("darwin", {}, "/Users/ss"), "/Users/ss/Library/Logs/Claude");
});

test("installing keeps the user's other MCP servers and settings, and never overwrites a broken file", () => {
  const entry = mcpServerEntry("https://example.test");
  const merged = JSON.parse(mergeConfig('{"mcpServers":{"other":{"command":"x"}},"preferences":{"a":1}}', entry));
  assert.deepEqual(merged.mcpServers.other, { command: "x" });
  assert.deepEqual(merged.preferences, { a: 1 });
  assert.deepEqual(merged.mcpServers[SERVER_NAME], entry);
  assert.deepEqual(JSON.parse(mergeConfig(undefined, entry)), { mcpServers: { [SERVER_NAME]: entry } });
  assert.deepEqual(JSON.parse(mergeConfig("  \n", entry)), { mcpServers: { [SERVER_NAME]: entry } });
  // Running it again only updates veriflow, never duplicates it
  assert.deepEqual(JSON.parse(mergeConfig(JSON.stringify(merged), entry)), merged);
  assert.throws(() => mergeConfig("{ not json", entry));
  assert.throws(() => mergeConfig("[]", entry), /not a JSON object/);
  assert.throws(() => mergeConfig('{"mcpServers":[]}', entry), /mcpServers/);
});
