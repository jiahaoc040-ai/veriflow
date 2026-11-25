/**
 * Read gateway/.env before loading any other module.
 * network.ts picks the network as it loads, so .env must be read before it; every module that needs .env imports this file first.
 */
import { config } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The gateway/ folder; relative paths to .env and key files resolve from here (MCP clients may start us from another folder) */
export const GATEWAY_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
config({ path: resolve(GATEWAY_DIR, ".env"), quiet: true });
