/**
 * MCP server 整合測試：用跟 Claude Desktop 一模一樣的啟動方式（mcpServerEntry 產生的指令），
 * 從根目錄、只帶最少的環境變數啟動，再透過 stdio 跟它對話。
 * 賣方網站用本機的假伺服器代替：不需要網路，也不會付款。
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { claudeConfigPath, claudeLogDir, mcpServerEntry, mergeConfig, SERVER_NAME } from "../src/mcp-launch.ts";

const BUYER = "2xBpaHottqhwFZURMZW4uZduQvpxNDSy46iXMYs9kceNGaPpZX"; // 測試用地址
const C1 = "ab".repeat(32);
const COMMITMENTS = [{ commitment: C1, asset: "BTC", as_of: "2026-11-19", issued_at: "2026-11-20T05:00:42+00:00", anchor_tx: null }];

let http: Server;
let gateway = "";
let client: Client;
let stderr = "";
const protocolErrors: Error[] = [];

/** 假的賣方網站：只回答 MCP 免費工具會問的端點 */
function fakeGateway(): Promise<string> {
  http = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = req.url ?? "";
    if (url === "/commitments") return send(200, COMMITMENTS);
    if (url === "/track-record") return send(200, { n: 0, hit_rate: null, horizon_days: 7 });
    if (url === `/eligibility/${BUYER}`) return send(200, { eligible: false, policy: { minAge: 18 } });
    if (url === `/commitments/${C1}`) return send(200, { ...COMMITMENTS[0], revealed: false });
    send(404, { error: "not found" });
  });
  return new Promise((ok) => http.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(http.address() as { port: number }).port}`)));
}

/** 格式正確、但沒有錢的一次性測試金鑰（不會簽任何交易） */
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
    env: { ...entry.env, BUYER_KEY_FILE: throwawayKeyFile() }, // SDK 只另外帶 HOME、PATH 等少數變數，跟 Claude Desktop 一樣
    cwd: "/", // Claude Desktop 不會在專案資料夾裡啟動我們
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

test("server starts from / with a minimal environment and lists the 5 tools with safety hints", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ["check_eligibility", "get_signal", "get_track_record", "list_commitments", "verify_signal"]);
  for (const t of tools) assert.equal(t.annotations?.readOnlyHint, t.name !== "get_signal", t.name);
  assert.match(client.getInstructions() ?? "", /zero-knowledge/);
  assert.match(stderr, new RegExp(`veriflow MCP ready \\(buyer ${BUYER}, gateway ${gateway.replace(/[.:/]/g, "\\$&")}\\)`));
});

test("free tools answer from the seller's public endpoints", async () => {
  assert.deepEqual(JSON.parse(text(await client.callTool({ name: "list_commitments", arguments: {} }))), COMMITMENTS);
  assert.equal(JSON.parse(text(await client.callTool({ name: "get_track_record", arguments: {} }))).horizon_days, 7);
  const elig = JSON.parse(text(await client.callTool({ name: "check_eligibility", arguments: {} })));
  assert.equal(elig.account, BUYER);
  assert.equal(elig.eligible, false);
  assert.equal(elig.verify_url, `${gateway}/verify?account=${BUYER}`);
});

test("errors come back as tool errors, not crashes", async () => {
  const unanchored = await client.callTool({ name: "verify_signal", arguments: { commitment: C1 } });
  assert.equal(unanchored.isError, true);
  assert.match(text(unanchored), /not been anchored/);
  const unknown = await client.callTool({ name: "verify_signal", arguments: { commitment: "cd".repeat(32) } });
  assert.equal(unknown.isError, true);
  assert.match(text(unknown), /404/);
  // 伺服器還活著
  assert.equal((await client.listTools()).tools.length, 5);
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
  // 重跑一次只會更新 veriflow，不會重複
  assert.deepEqual(JSON.parse(mergeConfig(JSON.stringify(merged), entry)), merged);
  assert.throws(() => mergeConfig("{ not json", entry));
  assert.throws(() => mergeConfig("[]", entry), /不是 JSON 物件/);
  assert.throws(() => mergeConfig('{"mcpServers":[]}', entry), /mcpServers/);
});
