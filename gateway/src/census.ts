/**
 * Agent Registry census (read-only): could a buyer agent safely pay each registered agent?
 * ------------------------------------------------------------------------------
 * Reads every CIS-8004 agent from a Concordium node (token ids from 1 upward, stopping after GAP consecutive missing ids)
 * and runs, for each Active agent, the same on-chain-verifiable checks VeriFlow's buyer makes before paying:
 *   - is a payout wallet (agentWallet) bound on-chain
 *   - is agent_uri https, does the Agent Card load, does its SHA-256 equal the on-chain metadata_hash
 *   - does the card declare a Verified by Concordium badge (declaration only; the official badge check is a hosted service and not run here)
 *   - if the card mentions x402: GET its https endpoints once; if one answers with an x402 402, is the Concordium payTo the on-chain agentWallet
 * Sends no transactions and pays nothing. CONCORDIUM_NETWORK selects the network (mainnet reads <10082,0>).
 *
 * Run: CONCORDIUM_NETWORK=mainnet npm run census   → census-report.json, census-summary.md
 */
import "./env-file.js";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { createGrpc, isTransient } from "./grpc.js";
import { readAgent, AGENT_REGISTRY_TEXT, type AgentOnChain } from "./registry-node.js";
import { badgeTokenAddress, readCapped, MAX_CARD_BYTES } from "./counterparty.js";
import { sameAccount } from "./contract-v2.js";
import { ownerOfKey, CIS8_REGISTRY } from "./cis8.js";
import { NET } from "./network.js";

export type Row = {
  id: string;
  status: "Active" | "Revoked" | "unreadable";
  reason?: string; // why the agent could not be read (e.g. node rate limit, HTTP 429)
  extRef?: boolean; // external_reference is set: the agent declares a key on another chain (CIS-8)
  extNs?: string;
  // That key's actual state in CIS-8: bound under this agent's owner / bound under someone else / not registered / revoked / points at another contract / read failed
  cis8?: "owner" | "other" | "none" | "revoked" | "other-contract" | "error";
  wallet?: boolean;
  walletIsOwner?: boolean;
  https?: boolean;
  card?: "ok" | "unreachable" | "not-json" | "none";
  hashMatch?: boolean | null; // null: no metadata_hash on-chain
  badge?: boolean;
  mentionsX402?: boolean;
  x402?: { url: string; networks: string[]; ccdPayToMatchesWallet: boolean | null; evmPayTo: boolean; cis8Key: boolean } | null;
};

const GAP = Number(process.env.CENSUS_GAP ?? 300);
const MAX_ID = Number(process.env.CENSUS_MAX_ID ?? 50_000);
const CONCURRENCY = Number(process.env.CENSUS_CONCURRENCY ?? 4);
// Time budget: when it runs out, stop reading higher ids and still write the report (marked partial, with the highest id read)
const BUDGET_MS = Number(process.env.CENSUS_BUDGET_MIN ?? 150) * 60_000;
const PROBES = Number(process.env.CENSUS_PROBES_PER_AGENT ?? 5);

// Public nodes rate-limit (HTTP 429): back off and retry, up to about 2 minutes
const rateLimited = (e: unknown) => /\b429\b|RESOURCE_EXHAUSTED|Too Many Requests/i.test(e instanceof Error ? e.message : String(e));
async function withRetry<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await f(); } catch (e) {
      const limited = rateLimited(e);
      if (i >= (limited ? 8 : 2) || !(limited || isTransient(e))) throw e;
      await new Promise((r) => setTimeout(r, limited ? Math.min(30_000, 1000 * 2 ** i) + Math.random() * 1000 : 1000 * (i + 1)));
    }
  }
}

const sameAcct = (a?: string | null, b?: string | null) => { try { return !!a && !!b && sameAccount(a, b); } catch { return false; } };

/** Every https URL in a card (deduplicated, excluding agent_uri itself) */
export function urlsIn(card: unknown, self: string): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === "string") { if (/^https:\/\/[^\s"'<>]+$/.test(v) && v !== self) out.add(v); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(card);
  return [...out];
}

// URLs of docs, specs, code hosting and the registry service itself are never a seller's paid endpoint: do not call them
const NOT_ENDPOINT = /^https:\/\/([^/]*\.)?(github\.com|githubusercontent\.com|eips\.ethereum\.org|docs\.[^/]+|agent-registry-mcp\.concordium\.com|ccdexplorer\.io|ccdscan\.io|x\.com|twitter\.com|t\.me|discord\.(gg|com)|linkedin\.com|medium\.com|youtube\.com)\//i;
/** Try URLs that look like paid endpoints first (containing x402 / pay / signal / api), then the rest */
export function probeOrder(urls: string[]): string[] {
  const cand = urls.filter((u) => !NOT_ENDPOINT.test(u) && !/\.(json|md|html?|png|jpe?g|svg|pdf)(\?|#|$)/i.test(u));
  const score = (u: string) => (/x402/i.test(u) ? 0 : /pay|signal|paid|api|judge|review/i.test(u) ? 1 : 2);
  return cand.sort((a, b) => score(a) - score(b));
}

/** Read an x402 402: v2 puts it in the PAYMENT-REQUIRED header, v1 in the JSON body */
export function acceptsOf402(header: string | null, body: string): { network: string; payTo: string; extra?: Record<string, unknown> }[] {
  try {
    if (header) return (decodePaymentRequiredHeader(header).accepts ?? []) as never;
  } catch { /* fall through */ }
  try {
    const j = JSON.parse(body);
    return Array.isArray(j?.accepts) ? j.accepts : [];
  } catch { return []; }
}

async function probe(url: string, wallet: string | null): Promise<Row["x402"]> {
  const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8_000), headers: { "User-Agent": "veriflow-census (read-only)" } });
  if (r.status !== 402) { await r.body?.cancel(); return null; }
  const body = (await readCapped(r, MAX_CARD_BYTES).catch(() => Buffer.alloc(0))).toString("utf8");
  const acc = acceptsOf402(r.headers.get("PAYMENT-REQUIRED"), body);
  if (!acc.length) return null;
  const ccd = acc.filter((a) => typeof a.network === "string" && a.network.startsWith("ccd:"));
  return {
    url,
    networks: [...new Set(acc.map((a) => String(a.network)))],
    ccdPayToMatchesWallet: ccd.length ? ccd.every((a) => sameAcct(a.payTo, wallet)) : null,
    evmPayTo: acc.some((a) => /^eip155:/.test(String(a.network))),
    cis8Key: acc.some((a) => !!(a.extra as { cis8?: unknown } | undefined)?.cis8),
  };
}

async function cis8State(a: AgentOnChain, grpc: ReturnType<typeof createGrpc>): Promise<Row["cis8"]> {
  const x = a.externalRef!;
  if (x.contract !== `<${CIS8_REGISTRY.index},${CIS8_REGISTRY.subindex}>`) return "other-contract";
  try {
    const r = await withRetry(() => ownerOfKey({ namespace: x.namespace, keyType: x.keyType, publicKey: x.publicKey }, grpc));
    if (!r) return "none";
    if (r.status !== "Active") return "revoked";
    return sameAcct(r.owner, a.owner) ? "owner" : "other";
  } catch { return "error"; }
}

async function inspect(id: string, a: AgentOnChain, grpc: ReturnType<typeof createGrpc>): Promise<Row> {
  const row: Row = { id, status: a.status, wallet: !!a.wallet, walletIsOwner: !!a.wallet && sameAcct(a.wallet, a.owner) };
  if (a.externalRef) Object.assign(row, { extRef: true, extNs: a.externalRef.namespace, cis8: await cis8State(a, grpc) });
  if (a.status !== "Active") return row;
  if (!a.agentUri) return { ...row, card: "none" };
  row.https = /^https:\/\//.test(a.agentUri);
  if (!row.https) return { ...row, card: "none" };
  let raw: Buffer;
  try {
    const r = await fetch(a.agentUri, { redirect: "error", signal: AbortSignal.timeout(6_000) });
    if (!r.ok) { await r.body?.cancel(); return { ...row, card: "unreachable" }; }
    raw = await readCapped(r, MAX_CARD_BYTES);
  } catch { return { ...row, card: "unreachable" }; }
  row.hashMatch = a.metadataHash ? createHash("sha256").update(raw).digest("hex") === a.metadataHash : null;
  let card: unknown;
  try { card = JSON.parse(raw.toString("utf8")); } catch { return { ...row, card: "not-json" }; }
  row.card = "ok";
  row.badge = !!badgeTokenAddress(card);
  row.mentionsX402 = /x402/i.test(raw.toString("utf8"));
  if (row.mentionsX402) {
    row.x402 = null;
    for (const u of probeOrder(urlsIn(card, a.agentUri)).slice(0, PROBES)) {
      try { const p = await probe(u, a.wallet); if (p) { row.x402 = p; break; } } catch { /* next */ }
    }
  }
  return row;
}

export type Summary = ReturnType<typeof summarize>;
export function summarize(rows: Row[]) {
  const n = (f: (r: Row) => boolean) => rows.filter(f).length;
  const active = rows.filter((r) => r.status === "Active");
  const cardOk = active.filter((r) => r.card === "ok");
  const x = active.filter((r) => r.x402);
  const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : 0);
  // "A buyer could pay safely": Active, payout wallet bound, card loads and its hash matches
  const payable = n((r) => r.status === "Active" && !!r.wallet && r.card === "ok" && r.hashMatch === true);
  return {
    agents: rows.length,
    active: active.length,
    revoked: n((r) => r.status === "Revoked"),
    unreadable: n((r) => r.status === "unreadable"),
    with_external_reference: n((r) => !!r.extRef),
    active_with_external_reference: n((r) => r.status === "Active" && !!r.extRef),
    active_ext_bound_to_owner: n((r) => r.status === "Active" && r.cis8 === "owner"),
    active_ext_bound_to_other: n((r) => r.status === "Active" && r.cis8 === "other"),
    active_ext_not_registered: n((r) => r.status === "Active" && r.cis8 === "none"),
    active_ext_revoked: n((r) => r.status === "Active" && r.cis8 === "revoked"),
    active_ext_other_contract: n((r) => r.status === "Active" && r.cis8 === "other-contract"),
    active_ext_read_error: n((r) => r.status === "Active" && r.cis8 === "error"),
    ext_namespaces: Object.fromEntries(Object.entries(rows.filter((r) => r.status === "Active" && r.extNs).reduce((m, r) => ((m[r.extNs!] = (m[r.extNs!] ?? 0) + 1), m), {} as Record<string, number>)).sort((a, b) => b[1] - a[1])),
    active_with_wallet: n((r) => r.status === "Active" && !!r.wallet),
    active_wallet_is_owner: n((r) => r.status === "Active" && !!r.walletIsOwner),
    active_card_ok: cardOk.length,
    active_card_unreachable: n((r) => r.status === "Active" && r.card === "unreachable"),
    active_no_https_card: n((r) => r.status === "Active" && (r.card === "none" || r.https === false)),
    active_hash_match: n((r) => r.status === "Active" && r.hashMatch === true),
    active_hash_mismatch: n((r) => r.status === "Active" && r.hashMatch === false),
    active_badge_declared: n((r) => r.status === "Active" && !!r.badge),
    active_mentions_x402: n((r) => r.status === "Active" && !!r.mentionsX402),
    x402_endpoints_found: x.length,
    x402_ccd_payto_matches_wallet: x.filter((r) => r.x402!.ccdPayToMatchesWallet === true).length,
    x402_ccd_payto_not_wallet: x.filter((r) => r.x402!.ccdPayToMatchesWallet === false).length,
    x402_evm_payto: x.filter((r) => r.x402!.evmPayTo).length,
    x402_evm_with_cis8_key: x.filter((r) => r.x402!.cis8Key).length,
    // Why the others fail, each agent counted once (first reason in this order), so these add up to active − payable
    fail_no_wallet_card_fails: n((r) => r.status === "Active" && !r.wallet && !(r.card === "ok" && r.hashMatch === true)),
    fail_no_wallet_card_ok: n((r) => r.status === "Active" && !r.wallet && r.card === "ok" && r.hashMatch === true),
    fail_wallet_no_https_card: n((r) => r.status === "Active" && !!r.wallet && (r.card === "none" || r.https === false)),
    fail_wallet_card_unreachable: n((r) => r.status === "Active" && !!r.wallet && r.https !== false && r.card === "unreachable"),
    fail_wallet_hash_mismatch: n((r) => r.status === "Active" && !!r.wallet && r.card === "ok" && r.hashMatch === false),
    payable_safely: payable,
    payable_safely_pct_of_active: pct(payable, active.length),
  };
}

/** The README of a census run, from its report (also used to re-render an old report after a wording fix) */
export function censusMarkdown(report: { run_at: string; highest_id: number; gap_stop: number; partial: boolean; summary: Summary }): string {
  const s = report.summary;
  const line = (k: string, v: number, of?: number) => `| ${k} | ${v}${of ? ` (${Math.round((1000 * v) / of) / 10}%)` : ""} |`;
  return [
    `## Agent Registry census — ${NET.name} ${AGENT_REGISTRY_TEXT}`,
    "",
    ...(report.partial ? [`**Partial:** stopped at the ${BUDGET_MS / 60_000}-minute budget; agents above id ${report.highest_id} were not read.`, ""] : []),
    `Run ${report.run_at}. Read-only: every agent read from a Concordium node (token ids 1–${report.highest_id}${report.partial ? "" : `, stopping after ${report.gap_stop} empty ids`}), Agent Cards fetched and hashed, x402 endpoints named in cards probed once with GET. No transactions, no payments.`,
    "",
    `**${s.payable_safely} of ${s.active} Active agents (${s.payable_safely_pct_of_active}%) pass the on-chain checks a buyer can make before paying:** a bound \`agentWallet\`, and an https Agent Card whose SHA-256 equals the on-chain hash.`,
    "",
    "| | |", "|---|---|",
    line("Agents read", s.agents),
    line("Active", s.active, s.agents),
    line("Revoked", s.revoked, s.agents),
    line("Could not be decoded", s.unreadable, s.agents),
    line("Active with an on-chain agentWallet", s.active_with_wallet, s.active),
    line("… of which the wallet is the owner account itself", s.active_wallet_is_owner, s.active),
    line("Active whose https card loads", s.active_card_ok, s.active),
    line("Active whose card cannot be loaded", s.active_card_unreachable, s.active),
    line("Active with no https card", s.active_no_https_card, s.active),
    line("Active whose card matches the on-chain hash", s.active_hash_match, s.active),
    line("Active whose card does NOT match the on-chain hash", s.active_hash_mismatch, s.active),
    line("Active declaring a Verified by Concordium badge in the card", s.active_badge_declared, s.active),
    line("Active linking an external (other-chain) key via external_reference", s.active_with_external_reference, s.active),
    line("… key bound in CIS-8 to the agent's owner (read from a node)", s.active_ext_bound_to_owner, s.active_with_external_reference),
    line("… key bound in CIS-8 to a different account", s.active_ext_bound_to_other, s.active_with_external_reference),
    line("… key not registered in CIS-8", s.active_ext_not_registered, s.active_with_external_reference),
    line("… CIS-8 binding revoked", s.active_ext_revoked, s.active_with_external_reference),
    line("… points at another contract", s.active_ext_other_contract, s.active_with_external_reference),
    line("… CIS-8 read failed", s.active_ext_read_error, s.active_with_external_reference),
    line("Active whose card mentions x402", s.active_mentions_x402, s.active),
    line("… with a live x402 402 found at a URL in the card", s.x402_endpoints_found),
    line("… … Concordium payTo = on-chain agentWallet", s.x402_ccd_payto_matches_wallet),
    line("… … Concordium payTo ≠ on-chain agentWallet", s.x402_ccd_payto_not_wallet),
    line("… … offering an EVM payTo", s.x402_evm_payto),
    line("… … EVM offer naming a CIS-8 key in `extra`", s.x402_evm_with_cis8_key),
    "",
    `Why the other ${s.active - s.payable_safely} fail, each agent counted once: no agentWallet, and the card also fails ${s.fail_no_wallet_card_fails}; no agentWallet, card fine ${s.fail_no_wallet_card_ok}; wallet bound but no https card ${s.fail_wallet_no_https_card}; wallet bound but the card does not load ${s.fail_wallet_card_unreachable}; wallet bound but the card changed since it was pinned ${s.fail_wallet_hash_mismatch}.`,
    "",
    `External key namespaces (Active): ${Object.entries(s.ext_namespaces).map(([k, v]) => `\`${k}\` ${v}`).join(", ") || "none"}.`,
    "",
    "Not checked here: the official badge check (a hosted service); CIS-8 keys an agent does not link through external_reference (CIS-8 has no listing by account); endpoints not named in the card or not answering GET.",
  ].join("\n");
}

async function main() {
  const grpc = createGrpc();
  const rows: Row[] = [];
  let next = 1, lastFound = 0, done = false, partial = false;
  const started = Date.now();
  const worker = async () => {
    while (!done) {
      const id = next++;
      if (id > MAX_ID || id - lastFound > GAP) { done = true; return; }
      if (Date.now() - started > BUDGET_MS) { done = partial = true; return; }
      let a: AgentOnChain | null;
      try {
        a = await withRetry(() => readAgent(String(id), grpc));
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        console.error(`agent #${id} unreadable: ${m}`);
        rows.push({ id: String(id), status: "unreadable", reason: m.slice(0, 200) });
        // A decode error means this id exists; a node error (e.g. rate limiting) does not, so it does not extend the search
        if (!rateLimited(e) && !isTransient(e)) lastFound = Math.max(lastFound, id);
        continue;
      }
      if (!a) continue;
      lastFound = Math.max(lastFound, id);
      rows.push(await inspect(String(id), a, grpc).catch(() => ({ id: String(id), status: a!.status }) as Row));
      if (rows.length % 100 === 0) console.error(`… ${rows.length} agents read (id ${id})`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  rows.sort((a, b) => Number(a.id) - Number(b.id));
  const s = summarize(rows);
  const report = { network: NET.name, registry: AGENT_REGISTRY_TEXT, run_at: new Date().toISOString(), highest_id: lastFound, gap_stop: GAP, partial, minutes: Math.round((Date.now() - started) / 6000) / 10, summary: s, rows };
  writeFileSync("census-report.json", JSON.stringify(report, null, 1));
  const md = censusMarkdown(report);
  writeFileSync("census-summary.md", md + "\n");
  console.log(md);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
