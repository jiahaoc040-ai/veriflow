/**
 * Shared settings: read .env, load Concordium account keys
 *
 * Key file = the private key file exported by the Concordium Browser Wallet (JSON).
 * Kept under gateway/keys/, which .gitignore excludes; never commit it.
 */
import { GATEWAY_DIR } from "./env-file.js"; // must come first: reads .env (network.ts needs CONCORDIUM_NETWORK when it loads)
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { AccountAddress, buildAccountSigner, parseWallet } from "@concordium/web-sdk";
import { NET } from "./network.js";

export { GATEWAY_DIR };

export const NETWORK = NET.caip2;

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`missing environment variable ${name} (see gateway/.env.example)`);
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
