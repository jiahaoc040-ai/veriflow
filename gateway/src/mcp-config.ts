/**
 * Claude Desktop setup helper
 * ------------------------
 *   npm run mcp:config                 check the environment and print the config (connects to the public site by default)
 *   npm run mcp:config -- --install    write it into Claude Desktop's config file (backs it up first; other MCP servers are left alone)
 *   npm run mcp:config -- --local      use a local gateway instead (GATEWAY_URL, default http://localhost:4020; start the gateway first)
 *
 * Checks: Node version, the buyer key file is readable (prints only the address, never the key), and whether the buyer account is already eligible on the target site.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { env, loadAccount } from "./config.js";
import { PUBLIC_GATEWAY, SERVER_NAME, claudeConfigPath, claudeLogDir, mcpServerEntry, mergeConfig } from "./mcp-launch.js";

const args = new Set(process.argv.slice(2));
const local = args.has("--local");
const install = args.has("--install");
const gateway = local ? env("GATEWAY_URL", "http://localhost:4020") : PUBLIC_GATEWAY;

const ok = (m: string) => console.log(`✅ ${m}`);
const warn = (m: string) => console.log(`⚠️  ${m}`);
function stop(m: string): never {
  console.log(`❌ ${m}`);
  process.exit(1);
}

// 1. Node: --import and import.meta.resolve need Node 20.6 or later
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 6)) stop(`Node ${process.versions.node} is too old; upgrade to 20.6 or later (22 LTS or later recommended)`);
ok(`Node ${process.versions.node}: ${process.execPath}`);

// 2. Buyer key (only the address is read; the key itself is never printed or written into the config)
let buyer: string;
try {
  buyer = loadAccount(env("BUYER_KEY_FILE")).address;
} catch (e) {
  stop(`cannot read the buyer key file (BUYER_KEY_FILE in gateway/.env): ${e instanceof Error ? e.message : String(e)}`);
}
ok(`buyer account (MCP pays from it): ${buyer}`);

// 3. Is the buyer already eligible on the target site?
try {
  const r = await fetch(`${gateway}/eligibility/${buyer}`, { signal: AbortSignal.timeout(90_000) });
  const j = (await r.json()) as { eligible?: boolean };
  if (j.eligible) ok(`eligible on ${gateway}: ready to buy signals`);
  else warn(`not yet eligible on ${gateway}: open ${gateway}/verify?account=${buyer} with your wallet once (get_signal will be refused until then; the other tools work)`);
} catch (e) {
  const why = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
  warn(`cannot reach ${gateway} (${why})${local ? " — is the local gateway running?" : " — run this command again once the network is up"}`);
}

// 4. The config entry
const entry = mcpServerEntry(gateway);
const path = claudeConfigPath();
console.log(`\nClaude Desktop config file: ${path}\nEntry to add ("${SERVER_NAME}" under mcpServers):\n`);
console.log(JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2));

if (!install) {
  console.log(`\nTo write it into the config file: npm run mcp:config -- --install${local ? " --local" : ""}`);
  process.exit(0);
}

// 5. Write (back up first; never write over a broken file)
let existing: string | undefined;
try {
  existing = readFileSync(path, "utf8");
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") stop(`cannot read the config file ${path}: ${e instanceof Error ? e.message : String(e)}`);
}
let merged: string;
try {
  merged = mergeConfig(existing, entry);
} catch (e) {
  stop(`the existing config file is not valid JSON, so nothing was written to avoid breaking it (${e instanceof Error ? e.message : String(e)}). Add the entry above by hand.`);
}
mkdirSync(dirname(path), { recursive: true });
if (existing !== undefined) {
  const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  writeFileSync(backup, existing, { flag: "wx" }); // back up what we just read; wx: never overwrite an existing file
  ok(`original config backed up: ${backup}`);
}
writeFileSync(path, merged);
ok(`written: ${path}`);

const quit = process.platform === "darwin" ? "menu bar Claude → Quit Claude (or ⌘Q)" : "quit Claude completely from the system tray / taskbar";
console.log(`
Next:
  1. Quit Claude Desktop completely (${quit}) and reopen it — closing the window is not enough
  2. In a chat, "+" at the bottom left → Connectors: you should see ${SERVER_NAME} (6 tools)
  3. If something goes wrong, read the log: ${claudeLogDir()}/mcp-server-${SERVER_NAME}.log`);
