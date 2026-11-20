/**
 * 怎麼讓 Claude Desktop（或任何 MCP 客戶端）啟動 VeriFlow 的 MCP server
 * ------------------------------------------------------------------
 * 不用 "command": "npx" / "tsx"：Claude Desktop 啟動 MCP server 時 PATH 很短、工作目錄也不是專案資料夾，
 * 常見錯誤是 "env: node: No such file or directory" 或 ENOENT。所以一律用絕對路徑：
 *   這台電腦 node 的路徑 + tsx loader（file:// URL）+ src/mcp.ts
 * 設定裡沒有任何金鑰：MCP server 自己讀 gateway/.env 與 keys/。
 */
import { homedir } from "node:os";
import { posix, resolve, win32 } from "node:path";
import { GATEWAY_DIR } from "./config.js";

export const PUBLIC_GATEWAY = "https://veriflow-yrhp.onrender.com";
export const SERVER_NAME = "veriflow";

export type ServerEntry = { command: string; args: string[]; env: Record<string, string> };

/** claude_desktop_config.json 裡 mcpServers.veriflow 的內容 */
export function mcpServerEntry(gatewayUrl: string, nodePath = process.execPath): ServerEntry {
  return {
    command: nodePath,
    args: ["--import", import.meta.resolve("tsx"), resolve(GATEWAY_DIR, "src", "mcp.ts")],
    env: { GATEWAY_URL: gatewayUrl },
  };
}

/** Claude Desktop 設定檔位置（modelcontextprotocol.io「Connect to local MCP servers」） */
export function claudeConfigPath(platform: string = process.platform, env = process.env, home = homedir()): string {
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32")
    return win32.join(env.APPDATA ?? win32.join(env.USERPROFILE ?? home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return posix.join(env.XDG_CONFIG_HOME ?? posix.join(home, ".config"), "Claude", "claude_desktop_config.json");
}

/** Claude Desktop 的 MCP 記錄檔資料夾（看 mcp-server-veriflow.log） */
export function claudeLogDir(platform: string = process.platform, env = process.env, home = homedir()): string {
  if (platform === "darwin") return posix.join(home, "Library", "Logs", "Claude");
  if (platform === "win32") return win32.join(env.APPDATA ?? win32.join(env.USERPROFILE ?? home, "AppData", "Roaming"), "Claude", "logs");
  return posix.join(env.XDG_CONFIG_HOME ?? posix.join(home, ".config"), "Claude", "logs");
}

/**
 * 把 veriflow 加進（或更新）既有設定：其他 MCP server 與其他設定都保留。
 * 原檔不是合法 JSON 物件就丟錯——呼叫端不寫檔，避免弄壞使用者的設定。
 */
export function mergeConfig(existingText: string | undefined, entry: ServerEntry): string {
  let cfg: Record<string, unknown> = {};
  if (existingText !== undefined && existingText.trim() !== "") {
    const parsed: unknown = JSON.parse(existingText);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("設定檔的內容不是 JSON 物件");
    cfg = parsed as Record<string, unknown>;
  }
  const servers = cfg.mcpServers ?? {};
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) throw new Error("設定檔裡的 mcpServers 不是物件");
  return JSON.stringify({ ...cfg, mcpServers: { ...(servers as object), [SERVER_NAME]: entry } }, null, 2) + "\n";
}
