/**
 * 共用設定：讀 .env、載入 Concordium 帳號金鑰
 *
 * 金鑰檔 = Concordium Browser Wallet 匯出的私鑰檔（JSON）。
 * 放在 gateway/keys/ 底下，這個資料夾已經被 .gitignore 排除，絕對不要 commit。
 */
import { GATEWAY_DIR } from "./env-file.js"; // 必須最先：讀 .env（network.ts 載入時就要用到 CONCORDIUM_NETWORK）
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { AccountAddress, buildAccountSigner, parseWallet } from "@concordium/web-sdk";
import { NET } from "./network.js";

export { GATEWAY_DIR };

export const NETWORK = NET.caip2;

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
