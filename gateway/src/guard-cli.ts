/**
 * Run the seller guard against any x402 seller
 * --------------------------------------------
 *   npm run guard -- check <url> [--method POST] [--json '<body>']   no wallet: read the 402 and check the seller, pay nothing
 *   npm run guard -- buy   <url> [--method POST] [--json '<body>']   pay with BUYER_KEY_FILE (testnet CCD, at most MAX_PAY_MICROCCD),
 *                                                                    only if every check passes
 * Options: --reputation off|advisory|block-no|require-go (default block-no on testnet, off on mainnet: vet402 is testnet-only) · --json-file <path> instead of --json
 *          --pay-network <caip2> (check mode: which payment option to check; default this Concordium network, else the first)
 * Mainnet: CONCORDIUM_NETWORK=mainnet npm run guard -- check <url> (read-only)
 *
 * The seller does not need to be VeriFlow's. Everything except the badge pointer is read from Concordium.
 */
import { readFileSync } from "node:fs";
import { x402Client, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactConcordiumScheme } from "@x402/concordium/exact/client";
import { getExplorerTxUrl } from "@x402/concordium";
import { NETWORK, env, loadAccount } from "./config.js";
import { NET } from "./network.js";
import { checkSellerAt, protect, summarize, type GuardPolicy, type GuardVerdict, type ReputationMode, type Requirement } from "./guard.js";
import { guardDeps } from "./guard-deps.js";

const USAGE = "usage: npm run guard -- check|buy <url> [--method POST] [--json '<body>' | --json-file <path>] [--reputation off|advisory|block-no|require-go]";
const [mode, url, ...rest] = process.argv.slice(2);
if ((mode !== "check" && mode !== "buy") || !url || !/^https?:\/\//.test(url)) {
  console.error(USAGE);
  process.exit(2);
}
const opt = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const body = opt("json") ?? (opt("json-file") ? readFileSync(opt("json-file")!, "utf8") : undefined);
const method = (opt("method") ?? (body ? "POST" : "GET")).toUpperCase();
// vet402 records testnet deliveries only: on mainnet its answer would be about a different agent with the same number, so it is off by default
const reputation = (opt("reputation") ?? (NET.name === "testnet" ? "block-no" : "off")) as ReputationMode;
if (!["off", "advisory", "block-no", "require-go"].includes(reputation)) {
  console.error(USAGE);
  process.exit(2);
}
const init: RequestInit = { method, ...(body ? { body, headers: { "content-type": "application/json" } } : {}) };
const policy: GuardPolicy = { reputation };
const deps = guardDeps();

function show(v: GuardVerdict) {
  console.log(`\nSeller behind ${v.origin}${v.tokenId ? `: agent #${v.tokenId}` : ""}`);
  v.checks.forEach((c, i) => console.log(`  ${c.ok ? "✓" : "✗"} ${i + 1}. ${c.name}\n       ${c.detail}`));
  console.log(`\n${v.ok ? "✅" : "⛔"} ${summarize(v)}`);
}

if (mode === "check") {
  const { verdict, options, picked } = await checkSellerAt(url, init, deps, policy, opt("pay-network") ?? undefined).catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
  const human = (a: Requirement) => (a.asset === "CCD" ? `${Number(a.amount) / 1e6} CCD` : `${a.amount} ${a.asset} (smallest unit)`);
  const where = (n: string) => (n.startsWith("ccd:") ? "Concordium" : n.startsWith("eip155:") ? `EVM chain ${n}` : n);
  console.log(`${url} asks to be paid: ${options.map((a) => `${human(a)} on ${where(a.network)} to ${a.payTo}`).join(" | ")}`);
  console.log(`checking the seller behind the ${human(picked)} option on ${where(picked.network)} (nothing is paid)`);
  show(verdict);
  process.exit(verdict.ok ? 0 : 1);
}

// buy
const buyer = loadAccount(env("BUYER_KEY_FILE"));
const maxPay = env("MAX_PAY_MICROCCD", "2000000");
const client = x402Client.fromConfig({
  schemes: [{ network: NETWORK, client: new ExactConcordiumScheme({ accountAddress: buyer.accountAddress, signer: buyer.signer }) }],
  spendControls: { allowedAssets: [{ network: NETWORK, asset: "CCD", maxAmountPerPayment: maxPay }] },
});
console.log(`buyer ${buyer.address} · pays testnet CCD only, at most ${Number(maxPay) / 1e6} CCD per payment`);
const guarded = protect(client, deps, policy, show);
const { response, verdict, error } = await guarded.fetch(url, init);
if (!response) {
  if (verdict && !verdict.ok) console.log("\nNothing was signed and nothing was paid.");
  else console.error(`\nrequest failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const ph = response.headers.get("PAYMENT-RESPONSE") ?? response.headers.get("X-PAYMENT-RESPONSE");
const paid = ph ? decodePaymentResponseHeader(ph) : undefined;
const text = await response.text();
console.log(`\nHTTP ${response.status}${paid?.transaction ? ` · paid: ${getExplorerTxUrl(NETWORK, paid.transaction)}` : ""}`);
console.log(text.length > 1500 ? `${text.slice(0, 1500)}… (${text.length} bytes)` : text);
process.exit(response.ok ? 0 : 1);
