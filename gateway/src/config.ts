/**
 * 共用設定：讀 .env、載入 Concordium 帳號金鑰
 *
 * 金鑰檔 = Concordium Browser Wallet 匯出的私鑰檔（JSON）。
 * 放在 gateway/keys/ 底下，這個資料夾已經被 .gitignore 排除，絕對不要 commit。
 */
import { config } from "dotenv";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountAddress, buildAccountSigner, parseWallet } from "@concordium/web-sdk";
import { CONCORDIUM_TESTNET_CAIP2 } from "@x402/concordium";

/** gateway/ 資料夾；.env 與金鑰檔的相對路徑都以這裡為準（MCP 客戶端可能從別的資料夾啟動我們） */
export const GATEWAY_DIR = resolve(fileURLToPath(new URL("..", import.meta.url)));
config({ path: resolve(GATEWAY_DIR, ".env"), quiet: true });

export const NETWORK = CONCORDIUM_TESTNET_CAIP2;

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`缺少環境變數 ${name}（請看 gateway/.env.example）`);
  return v;
}

export function loadAccount(keyFile: string) {
  const path = isAbsolute(keyFile) ? keyFile : resolve(GATEWAY_DIR, keyFile);
  const wallet = parseWallet(readFileSync(path, "utf8"));
  const address = wallet.value.address;
  return {
    address,
    accountAddress: AccountAddress.fromBase58(address),
    signer: buildAccountSigner(wallet),
  };
}
