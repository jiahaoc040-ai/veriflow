#!/usr/bin/env node
/**
 * npx concordium-x402-guard check <url> [--method POST] [--json '<body>'] [--network testnet|mainnet]
 *                                       [--reputation off|advisory|block-no|require-go] [--pay-network <caip2>] [--json-out]
 * Reads the seller's 402 and runs the checks. No wallet, nothing is paid. Exit code 0 = checks pass, 1 = refused, 2 = usage/error.
 */
import { checkSellerAt, summarize, type ReputationMode } from "./guard.js";
import { concordiumGuardDeps } from "./deps.js";
import type { NetworkName } from "./networks.js";

const USAGE = `usage: npx concordium-x402-guard check <https-url> [--method GET|POST] [--json '<body>'] [--network testnet|mainnet]
                                        [--reputation off|advisory|block-no|require-go] [--pay-network <caip2>] [--json-out]
Reads the seller's x402 402 answer and checks the seller on Concordium. No wallet; nothing is paid.`;

const [cmd, url, ...rest] = process.argv.slice(2);
const opt = (n: string) => {
  const i = rest.indexOf(`--${n}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
if (cmd !== "check" || !url || !/^https?:\/\//.test(url) || rest.includes("--help")) {
  console.error(USAGE);
  process.exit(2);
}
const network = (opt("network") ?? "testnet") as NetworkName;
const reputation = opt("reputation") as ReputationMode | undefined;
if (reputation && !["off", "advisory", "block-no", "require-go"].includes(reputation)) {
  console.error(USAGE);
  process.exit(2);
}
const body = opt("json");
const init: RequestInit = { method: (opt("method") ?? (body ? "POST" : "GET")).toUpperCase(), ...(body ? { body, headers: { "content-type": "application/json" } } : {}) };
const why = (x: unknown): string => (x instanceof Error ? `${x.message}${x.cause ? ` (${why(x.cause)})` : ""}` : String(x));

try {
  const deps = concordiumGuardDeps({ network });
  const { verdict, options, picked } = await checkSellerAt(url, init, deps, reputation ? { reputation } : {}, opt("pay-network"));
  if (rest.includes("--json-out")) {
    console.log(JSON.stringify({ ...verdict, summary: summarize(verdict), picked, options }, null, 2));
  } else {
    const amount = (a: { amount?: string; asset?: string }) => (a.asset === "CCD" ? `${Number(a.amount) / 1e6} CCD` : `${a.amount ?? "?"} ${a.asset ?? ""} (smallest unit)`);
    console.log(`${url} asks to be paid: ${options.map((a) => `${amount(a)} on ${a.network} to ${a.payTo}`).join(" | ")}`);
    console.log(`checking the ${amount(picked)} option on ${picked.network} against Concordium ${network} (nothing is paid)\n`);
    console.log(`Seller behind ${verdict.origin}${verdict.tokenId ? `: agent #${verdict.tokenId}` : ""}`);
    verdict.checks.forEach((c, i) => console.log(`  ${c.ok ? "✓" : "✗"} ${i + 1}. ${c.name}\n       ${c.detail}`));
    console.log(`\n${verdict.ok ? "✅" : "⛔"} ${summarize(verdict)}`);
  }
  process.exit(verdict.ok ? 0 : 1);
} catch (e) {
  console.error(`${url}: ${why(e)}`);
  process.exit(2);
}
