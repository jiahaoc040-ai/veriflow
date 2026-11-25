/**
 * Agent Registry 普查（唯讀）：一個買方 agent 能不能「安全地付錢」給登記的 agent？
 * ------------------------------------------------------------------------------
 * 從 Concordium 節點逐一讀 CIS-8004 的 agent（token id 從 1 往上，連續 GAP 個不存在就停），
 * 對每個 Active 的 agent 做 VeriFlow 買方在付款前做的同一套鏈上可驗證的檢查：
 *   - 有沒有在鏈上綁收款錢包（agentWallet）
 *   - agent_uri 是 https、Agent Card 讀得到、SHA-256 等於鏈上 metadata_hash
 *   - Card 有沒有 Verified by Concordium badge 的擴充欄位（只看宣告；官方 badge 檢查是託管服務，這裡不跑）
 *   - Card 若提到 x402：去它列的 https 端點 GET 一次，若回 x402 的 402，看 Concordium 的 payTo 是否就是鏈上 agentWallet
 * 不送任何交易、不付款。網路由 CONCORDIUM_NETWORK 決定（mainnet 讀 <10082,0>）。
 *
 * 執行：CONCORDIUM_NETWORK=mainnet npm run census   → census-report.json、census-summary.md
 */
import "./env-file.js";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { createGrpc, isTransient } from "./grpc.js";
import { readAgent, AGENT_REGISTRY_TEXT, type AgentOnChain } from "./registry-node.js";
import { badgeTokenAddress, readCapped, MAX_CARD_BYTES } from "./counterparty.js";
import { sameAccount } from "./contract-v2.js";
import { NET } from "./network.js";

export type Row = {
  id: string;
  status: "Active" | "Revoked" | "unreadable";
  extRef?: boolean; // external_reference 已設定（通常是連到 CIS-8 的外部金鑰）；這個讀取器不解析它
  wallet?: boolean;
  walletIsOwner?: boolean;
  https?: boolean;
  card?: "ok" | "unreachable" | "not-json" | "none";
  hashMatch?: boolean | null; // null：鏈上沒有 metadata_hash
  badge?: boolean;
  mentionsX402?: boolean;
  x402?: { url: string; networks: string[]; ccdPayToMatchesWallet: boolean | null; evmPayTo: boolean; cis8Key: boolean } | null;
};

const GAP = Number(process.env.CENSUS_GAP ?? 300);
const MAX_ID = Number(process.env.CENSUS_MAX_ID ?? 50_000);
const CONCURRENCY = Number(process.env.CENSUS_CONCURRENCY ?? 24);
// 時間預算：到了就停止往上讀，照樣寫出報告（標示 partial 與讀到的最高 id）
const BUDGET_MS = Number(process.env.CENSUS_BUDGET_MIN ?? 40) * 60_000;
const PROBES = Number(process.env.CENSUS_PROBES_PER_AGENT ?? 3);

async function withRetry<T>(f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try { return await f(); } catch (e) { if (i >= 2 || !isTransient(e)) throw e; await new Promise((r) => setTimeout(r, 1000 * (i + 1))); }
  }
}

const sameAcct = (a?: string | null, b?: string | null) => { try { return !!a && !!b && sameAccount(a, b); } catch { return false; } };

/** Card 裡所有 https 網址（去重、不含 agent_uri 本身） */
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

/** 讀一個 x402 的 402：v2 在 PAYMENT-REQUIRED 標頭，v1 在 JSON body */
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

async function inspect(id: string, a: AgentOnChain): Promise<Row> {
  const row: Row = { id, status: a.status, wallet: !!a.wallet, walletIsOwner: !!a.wallet && sameAcct(a.wallet, a.owner) };
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
    for (const u of urlsIn(card, a.agentUri).slice(0, PROBES)) {
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
  // 「買方可以安全付款」：Active、綁了收款錢包、Card 讀得到且雜湊吻合
  const payable = n((r) => r.status === "Active" && !!r.wallet && r.card === "ok" && r.hashMatch === true);
  return {
    agents: rows.length,
    active: active.length,
    revoked: n((r) => r.status === "Revoked"),
    unreadable: n((r) => r.status === "unreadable"),
    with_external_reference: n((r) => !!r.extRef),
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
    payable_safely: payable,
    payable_safely_pct_of_active: pct(payable, active.length),
  };
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
        // 這個讀取器不解析 external_reference：記下來，算「有連外部金鑰」，狀態未知
        rows.push({ id: String(id), status: "unreadable", extRef: /external_reference/.test(m) });
        lastFound = Math.max(lastFound, id);
        continue;
      }
      if (!a) continue;
      lastFound = Math.max(lastFound, id);
      rows.push(await inspect(String(id), a).catch(() => ({ id: String(id), status: a!.status }) as Row));
      if (rows.length % 100 === 0) console.error(`… ${rows.length} agents read (id ${id})`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  rows.sort((a, b) => Number(a.id) - Number(b.id));
  const s = summarize(rows);
  const report = { network: NET.name, registry: AGENT_REGISTRY_TEXT, run_at: new Date().toISOString(), highest_id: lastFound, gap_stop: GAP, partial, minutes: Math.round((Date.now() - started) / 6000) / 10, summary: s, rows };
  writeFileSync("census-report.json", JSON.stringify(report, null, 1));
  const line = (k: string, v: number, of?: number) => `| ${k} | ${v}${of ? ` (${Math.round((1000 * v) / of) / 10}%)` : ""} |`;
  const md = [
    `## Agent Registry census — ${NET.name} ${AGENT_REGISTRY_TEXT}`,
    "",
    ...(partial ? [`**Partial:** stopped at the ${BUDGET_MS / 60_000}-minute budget; agents above id ${lastFound} were not read.`, ""] : []),
    `Run ${report.run_at}. Read-only: every agent read from a Concordium node (token ids 1–${lastFound}${partial ? "" : `, stopping after ${GAP} empty ids`}), Agent Cards fetched and hashed, x402 endpoints named in cards probed once with GET. No transactions, no payments.`,
    "",
    `**${s.payable_safely} of ${s.active} Active agents (${s.payable_safely_pct_of_active}%) pass the on-chain checks a buyer can make before paying:** a bound \`agentWallet\`, and an https Agent Card whose SHA-256 equals the on-chain hash.`,
    "",
    "| | |", "|---|---|",
    line("Agents read", s.agents),
    line("Active", s.active, s.agents),
    line("Revoked", s.revoked, s.agents),
    line("Not decoded (external_reference set; status unknown)", s.unreadable, s.agents),
    line("Active with an on-chain agentWallet", s.active_with_wallet, s.active),
    line("… of which the wallet is the owner account itself", s.active_wallet_is_owner, s.active),
    line("Active whose https card loads", s.active_card_ok, s.active),
    line("Active whose card cannot be loaded", s.active_card_unreachable, s.active),
    line("Active with no https card", s.active_no_https_card, s.active),
    line("Active whose card matches the on-chain hash", s.active_hash_match, s.active),
    line("Active whose card does NOT match the on-chain hash", s.active_hash_mismatch, s.active),
    line("Active declaring a Verified by Concordium badge in the card", s.active_badge_declared, s.active),
    line("Active whose card mentions x402", s.active_mentions_x402, s.active),
    line("… with a live x402 402 found at a URL in the card", s.x402_endpoints_found),
    line("… … Concordium payTo = on-chain agentWallet", s.x402_ccd_payto_matches_wallet),
    line("… … Concordium payTo ≠ on-chain agentWallet", s.x402_ccd_payto_not_wallet),
    line("… … offering an EVM payTo", s.x402_evm_payto),
    line("… … EVM offer naming a CIS-8 key in `extra`", s.x402_evm_with_cis8_key),
    "",
    "Not checked here: the official badge check (a hosted service), CIS-8 bindings (the registry has no listing by account), endpoints not named in the card or not answering GET.",
  ].join("\n");
  writeFileSync("census-summary.md", md + "\n");
  console.log(md);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
