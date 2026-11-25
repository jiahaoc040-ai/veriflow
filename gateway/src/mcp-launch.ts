/**
 * How Claude Desktop (or any MCP client) launches VeriFlow's MCP server
 * ------------------------------------------------------------------
 * Not "command": "npx" / "tsx": Claude Desktop starts MCP servers with a short PATH and outside the project folder,
 * and the usual errors are "env: node: No such file or directory" or ENOENT. So everything uses absolute paths:
 *   this machine's node path + the tsx loader (file:// URL) + src/mcp.ts
 * The config holds no keys: the MCP server reads gateway/.env and keys/ itself.
 */
import { homedir } from "node:os";
import { posix, resolve, win32 } from "node:path";
import { GATEWAY_DIR } from "./config.js";

export const PUBLIC_GATEWAY = "https://veriflow-yrhp.onrender.com";
export const SERVER_NAME = "veriflow";

export type ServerEntry = { command: string; args: string[]; env: Record<string, string> };

/** The content of mcpServers.veriflow in claude_desktop_config.json */
export function mcpServerEntry(gatewayUrl: string, nodePath = process.execPath): ServerEntry {
  return {
    command: nodePath,
    args: ["--import", import.meta.resolve("tsx"), resolve(GATEWAY_DIR, "src", "mcp.ts")],
    env: { GATEWAY_URL: gatewayUrl },
  };
}

/** Where Claude Desktop's config file lives (modelcontextprotocol.io, "Connect to local MCP servers") */
export function claudeConfigPath(platform: string = process.platform, env = process.env, home = homedir()): string {
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  if (platform === "win32")
    return win32.join(env.APPDATA ?? win32.join(env.USERPROFILE ?? home, "AppData", "Roaming"), "Claude", "claude_desktop_config.json");
  return posix.join(env.XDG_CONFIG_HOME ?? posix.join(home, ".config"), "Claude", "claude_desktop_config.json");
}

/** Claude Desktop's MCP log folder (see mcp-server-veriflow.log) */
export function claudeLogDir(platform: string = process.platform, env = process.env, home = homedir()): string {
  if (platform === "darwin") return posix.join(home, "Library", "Logs", "Claude");
  if (platform === "win32") return win32.join(env.APPDATA ?? win32.join(env.USERPROFILE ?? home, "AppData", "Roaming"), "Claude", "logs");
  return posix.join(env.XDG_CONFIG_HOME ?? posix.join(home, ".config"), "Claude", "logs");
}

/**
 * Add (or update) veriflow in an existing config: other MCP servers and settings are kept.
 * If the file is not a valid JSON object, throw — the caller then writes nothing, so the user's config is never broken.
 */
export function mergeConfig(existingText: string | undefined, entry: ServerEntry): string {
  let cfg: Record<string, unknown> = {};
  if (existingText !== undefined && existingText.trim() !== "") {
    const parsed: unknown = JSON.parse(existingText);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("the config file's content is not a JSON object");
    cfg = parsed as Record<string, unknown>;
  }
  const servers = cfg.mcpServers ?? {};
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) throw new Error("mcpServers in the config file is not an object");
  return JSON.stringify({ ...cfg, mcpServers: { ...(servers as object), [SERVER_NAME]: entry } }, null, 2) + "\n";
}
