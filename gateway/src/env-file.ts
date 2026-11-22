/**
 * 先讀 gateway/.env，再載入其他模組。
 * network.ts 在載入時就決定網路，所以 .env 必須比它更早讀進來；任何需要 .env 的模組都先 import 這個檔案。
 */
import { config } from "dotenv";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** gateway/ 資料夾；.env 與金鑰檔的相對路徑都以這裡為準（MCP 客戶端可能從別的資料夾啟動我們） */
export const GATEWAY_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
config({ path: resolve(GATEWAY_DIR, ".env"), quiet: true });
