/**
 * Claude Desktop 設定小幫手
 * ------------------------
 *   npm run mcp:config                 檢查環境並印出設定（預設連公開網站）
 *   npm run mcp:config -- --install    直接寫進 Claude Desktop 設定檔（先備份；其他 MCP server 不動）
 *   npm run mcp:config -- --local      改連本機 gateway（GATEWAY_URL，預設 http://localhost:4020；要先跑 gateway）
 *
 * 會檢查：Node 版本、買方金鑰檔讀得到（只印地址，不印金鑰）、買方帳號在目標網站是否已通過資格驗證。
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

// 1. Node：--import 與 import.meta.resolve 需要 Node 20.6 以上
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 20 || (major === 20 && minor < 6)) stop(`Node ${process.versions.node} 太舊，請升級到 20.6 以上（建議 22 LTS 以上）`);
ok(`Node ${process.versions.node}：${process.execPath}`);

// 2. 買方金鑰（只讀地址；金鑰本身不會被印出或寫進設定）
let buyer: string;
try {
  buyer = loadAccount(env("BUYER_KEY_FILE")).address;
} catch (e) {
  stop(`讀不到買方金鑰檔（gateway/.env 的 BUYER_KEY_FILE）：${e instanceof Error ? e.message : String(e)}`);
}
ok(`買方帳號（MCP 用它付款）：${buyer}`);

// 3. 買方在目標網站是否已通過資格驗證
try {
  const r = await fetch(`${gateway}/eligibility/${buyer}`, { signal: AbortSignal.timeout(90_000) });
  const j = (await r.json()) as { eligible?: boolean };
  if (j.eligible) ok(`已在 ${gateway} 通過資格驗證，可以直接買訊號`);
  else warn(`還沒在 ${gateway} 通過資格驗證：用錢包打開 ${gateway}/verify?account=${buyer} 做一次（get_signal 會被拒絕，其他工具照常）`);
} catch (e) {
  const why = e instanceof Error ? (e.cause instanceof Error ? e.cause.message : e.message) : String(e);
  warn(`連不到 ${gateway}（${why}）${local ? "——本機 gateway 有在跑嗎？" : "——網路通了再跑一次這個指令確認"}`);
}

// 4. 設定內容
const entry = mcpServerEntry(gateway);
const path = claudeConfigPath();
console.log(`\nClaude Desktop 設定檔：${path}\n要加入的內容（mcpServers 裡的 "${SERVER_NAME}"）：\n`);
console.log(JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2));

if (!install) {
  console.log(`\n要直接寫進設定檔：npm run mcp:config -- --install${local ? " --local" : ""}`);
  process.exit(0);
}

// 5. 寫入（先備份；原檔壞掉就不寫）
let existing: string | undefined;
try {
  existing = readFileSync(path, "utf8");
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") stop(`讀不到設定檔 ${path}：${e instanceof Error ? e.message : String(e)}`);
}
let merged: string;
try {
  merged = mergeConfig(existing, entry);
} catch (e) {
  stop(`原本的設定檔不是合法 JSON，為了不弄壞它，沒有寫入（${e instanceof Error ? e.message : String(e)}）。請手動把上面的內容加進去。`);
}
mkdirSync(dirname(path), { recursive: true });
if (existing !== undefined) {
  const backup = `${path}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  writeFileSync(backup, existing, { flag: "wx" }); // 備份剛剛讀到的內容；wx：絕不覆蓋既有檔案
  ok(`原設定已備份：${backup}`);
}
writeFileSync(path, merged);
ok(`已寫入 ${path}`);

const quit = process.platform === "darwin" ? "選單列 Claude → Quit Claude（或 ⌘Q）" : "從系統匣／工作列完全結束 Claude";
console.log(`
下一步：
  1. 完全結束 Claude Desktop（${quit}），再重新打開——只關視窗不算
  2. 對話框左下角「+」→ Connectors，應該看到 ${SERVER_NAME}（6 個工具）
  3. 有問題看記錄：${claudeLogDir()}/mcp-server-${SERVER_NAME}.log`);
