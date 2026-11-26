/**
 * Verify the seller before paying (used by buyer agents)
 * ------------------------------
 * The seller checks the buyer with a zero-knowledge proof; this is the other direction: before paying, the buyer confirms who is being paid.
 * Everything is checked against Concordium's Agent Registry (CIS-8004 <12802,0>, via the official hosted MCP and a node), not the seller's own claims:
 *
 *   1. the seller's Agent Card declares a Verified by Concordium badge
 *   2. that badge exists in the Registry and is Active
 *   3. the official check_badge passes in full (the owner is an identity-verified person, the card is well-formed, …)
 *   4. we download the Agent Card and compute its SHA-256 ourselves; it equals the metadata_hash pinned on-chain (the card was not swapped)
 *   5. the address x402 asks us to pay (payTo) = the agentWallet registered on-chain —
 *      stops impostors who copy someone's badge but collect the money at their own address
 *
 * If any check fails, do not pay (fail closed). If the Registry cannot be reached, do not pay either.
 */
import type { AgentOnChain } from "./agent-record.js";
import { createHash } from "node:crypto";
import { AccountAddress } from "@concordium/web-sdk";

/** One named check with its outcome and the values it compared */
export type Check = { name: string; ok: boolean; detail: string };

export const BADGE_EXTENSION = "https://docs.concordium.com/a2a-extensions/concordium-badge/v1";
/** Top-level x402 PaymentRequired extension: names the agent being paid (only a pointer; the wallet is read from the chain) */
export const AGENT_EXTENSION = "concordium-agent";

export type RegistryCall = (name: string, args: Record<string, unknown>) => Promise<any>;

export type SellerVerdict = {
  ok: boolean;
  checks: Check[];
  payTo: string;
  tokenAddress?: string;
  tokenId?: string;
  owner?: string;
  agentWallet?: string;
};

/** The badge's token address in an Agent Card ("ccd:<genesis>/cis-2:JyP9…" → "JyP9…") */
/** Agent Cards are capped at 64 KiB: a seller returning a huge or endless body cannot stall the buyer */
export const MAX_CARD_BYTES = 64 * 1024;

export async function readCapped(r: Response, max: number): Promise<Buffer> {
  const len = Number(r.headers.get("content-length") ?? "0");
  if (len > max) throw new Error(`response larger than ${max} bytes`);
  if (!r.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = r.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error(`response larger than ${max} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export function badgeTokenAddress(card: unknown): string | undefined {
  const exts = (card as { capabilities?: { extensions?: { uri?: string; params?: { tokenAddress?: string } }[] } })?.capabilities
    ?.extensions;
  const ext = exts?.find((e) => e?.uri === BADGE_EXTENSION);
  const raw = ext?.params?.tokenAddress;
  if (typeof raw !== "string") return undefined;
  const short = raw.split(":").pop();
  return short && /^[1-9A-HJ-NP-Za-km-z]{10,40}$/.test(short) ? short : undefined;
}

export async function verifySeller(opts: {
  gateway: string;
  payTo: string;
  registry: RegistryCall;
  network?: string;
  fetch?: typeof fetch;
  /** Read the CIS-8004 agent record straight from a node; if given, status, card location and hash, and payout wallet all come from the node */
  readAgent?: (tokenId: string) => Promise<AgentOnChain | null>;
  /** The agent and badge named by the 402's concordium-agent extension (must agree if present) */
  expectTokenId?: string;
  expectBadge?: string;
  /** When payTo is not on Concordium (e.g. USDC on Base), this replaces the payTo = agentWallet check; it receives the owner and wallet read from the node */
  payToCheck?: (agent: { owner?: string; wallet?: string; externalRef?: AgentOnChain["externalRef"] | undefined }) => Promise<Check>;
  /** Tests only: allow an Agent Card at http://127.0.0.1 or http://localhost */
  allowLocalHttpCards?: boolean;
}): Promise<SellerVerdict> {
  const f = opts.fetch ?? fetch;
  const network = opts.network ?? "testnet";
  const checks: Check[] = [];
  const out: SellerVerdict = { ok: false, checks, payTo: opts.payTo };
  const done = () => ({ ...out, ok: checks.length === 5 && checks.every((c) => c.ok) });
  const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // 1. The badge declared by the seller's site
  let tokenAddress: string | undefined;
  try {
    const r = await f(`${opts.gateway}/.well-known/agent-card.json`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    tokenAddress = r.ok ? badgeTokenAddress(JSON.parse((await readCapped(r, MAX_CARD_BYTES)).toString("utf8"))) : undefined;
    checks.push({
      name: "seller advertises a Verified by Concordium badge",
      ok: !!tokenAddress,
      detail: tokenAddress ? `badge ${tokenAddress}` : `no badge in ${opts.gateway}/.well-known/agent-card.json (HTTP ${r.status})`,
    });
  } catch (e) {
    checks.push({ name: "seller advertises a Verified by Concordium badge", ok: false, detail: err(e) });
  }
  if (!tokenAddress) return done();
  out.tokenAddress = tokenAddress;

  // 2. The Registry record
  let rec: { token_id?: string; owner_account?: string; agent_uri?: string; metadata_hash_hex?: string; agent_wallet?: string; status?: string };
  // undefined = not read (no node answer), null = read, and the agent has none
  let externalRef: AgentOnChain["externalRef"] | undefined = undefined;
  try {
    rec = await opts.registry("agent_by_token_address", { network, token_address: tokenAddress });
  } catch (e) {
    checks.push({ name: "registered and Active in the CIS-8004 Agent Registry", ok: false, detail: `registry unreachable: ${err(e)}` });
    return done();
  }
  // The hosted service is only used to find the token id from the badge; the record itself is read from a node, and if they disagree we do not pay
  const problems: string[] = [];
  if (opts.expectBadge && opts.expectBadge !== tokenAddress) problems.push(`the 402 names badge ${opts.expectBadge}, the card advertises ${tokenAddress}`);
  if (opts.expectTokenId && rec.token_id !== opts.expectTokenId)
    problems.push(`the 402 names agent #${opts.expectTokenId}, the badge resolves to #${rec.token_id ?? "?"}`);
  let source = "hosted registry service";
  if (opts.readAgent && !rec.token_id) problems.push("the hosted service returned no token id, so the agent cannot be read from a node");
  if (opts.readAgent && rec.token_id) {
    try {
      const node = await opts.readAgent(rec.token_id);
      if (!node) problems.push(`agent #${rec.token_id} not found on-chain`);
      else if (node.tokenId !== rec.token_id) problems.push(`node returned agent #${node.tokenId} for #${rec.token_id}`);
      else {
        source = "read from a Concordium node";
        if ((rec.agent_wallet ?? null) !== node.wallet) problems.push("hosted service and node disagree on agentWallet");
        if ((rec.metadata_hash_hex?.toLowerCase() ?? null) !== node.metadataHash) problems.push("hosted service and node disagree on the card hash");
        if ((rec.agent_uri ?? null) !== node.agentUri) problems.push("hosted service and node disagree on agent_uri");
        externalRef = node.externalRef ?? null;
        rec = { token_id: node.tokenId, owner_account: node.owner, agent_uri: node.agentUri ?? undefined, metadata_hash_hex: node.metadataHash ?? undefined, agent_wallet: node.wallet ?? undefined, status: node.status };
      }
    } catch (e) {
      problems.push(`node unreachable: ${err(e)}`);
    }
  }
  out.tokenId = rec.token_id;
  out.owner = rec.owner_account;
  out.agentWallet = rec.agent_wallet;
  checks.push({
    name: "registered and Active in the CIS-8004 Agent Registry",
    ok: rec.status === "Active" && problems.length === 0,
    detail: `agent #${rec.token_id ?? "?"}, status ${rec.status ?? "not found"}, owner ${rec.owner_account ?? "?"} (${source})${problems.length ? `; ${problems.join("; ")}` : ""}`,
  });

  // 3. Official badge check
  try {
    const b = await opts.registry("check_badge", { network, id: tokenAddress });
    const failed = Object.entries(b?.checks ?? {}).filter(([, v]) => v === false).map(([k]) => k);
    checks.push({
      name: "official badge check passes (identity-verified owner)",
      // Every sub-check must pass too, not only the summary flag
      ok: b?.badge_valid === true && failed.length === 0,
      detail: b?.badge_valid && failed.length === 0 ? `${Object.keys(b.checks ?? {}).length} checks passed` : `failed: ${[...failed, ...((b?.issues ?? []) as unknown[]).map((i) => (typeof i === "string" ? i : (i as { field?: string; message?: string })?.message ? `${(i as { field?: string }).field ?? ""}: ${(i as { message: string }).message}` : JSON.stringify(i)))].join(", ") || "badge not valid"}`,
    });
  } catch (e) {
    checks.push({ name: "official badge check passes (identity-verified owner)", ok: false, detail: `registry unreachable: ${err(e)}` });
  }

  // 4. Download the card and hash it ourselves (only for a record the node confirmed: never fetch an address from an unconfirmed record)
  try {
    if (problems.length > 0) throw new Error("skipped: the agent record could not be confirmed (see check 2)");
    if (!rec.agent_uri) throw new Error("no agent_uri on-chain");
    cardUrlAllowed(rec.agent_uri, opts.allowLocalHttpCards === true);
    if (opts.allowLocalHttpCards !== true) await cardHostIsPublic(rec.agent_uri);
    const r = await f(rec.agent_uri, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const sha = createHash("sha256").update(await readCapped(r, MAX_CARD_BYTES)).digest("hex");
    checks.push({
      name: "Agent Card unchanged since pinned on-chain (own SHA-256)",
      ok: !!rec.metadata_hash_hex && sha === rec.metadata_hash_hex.toLowerCase(),
      detail: `sha256 ${sha} vs on-chain ${rec.metadata_hash_hex ?? "none"}`,
    });
  } catch (e) {
    checks.push({ name: "Agent Card unchanged since pinned on-chain (own SHA-256)", ok: false, detail: err(e) });
  }

  // 5. Payout address binding
  if (opts.payToCheck) {
    try {
      checks.push(await opts.payToCheck({ owner: rec.owner_account, wallet: rec.agent_wallet, externalRef }));
    } catch (e) {
      checks.push({ name: "payTo is bound to the agent on-chain", ok: false, detail: err(e) });
    }
    return done();
  }
  checks.push({
    name: "payTo is the agent's on-chain wallet",
    // Concordium account aliases (same first 29 bytes) are the same account
    ok: !!rec.agent_wallet && sameAccountSafe(rec.agent_wallet, opts.payTo),
    detail: `payTo ${opts.payTo}, on-chain agentWallet ${rec.agent_wallet || "not set"}`,
  });
  return done();
}

/** One-line summary for people */
export function summarize(v: SellerVerdict): string {
  const bad = v.checks.filter((c) => !c.ok);
  return v.ok
    ? `seller verified: agent #${v.tokenId} (${v.tokenAddress}), owner ${v.owner}, ${v.checks[4]?.name.includes("CIS-8") ? "paying an EVM address bound to it in CIS-8" : "paying its on-chain wallet"}`
    : `refused to pay: ${bad.map((c) => `${c.name} — ${c.detail}`).join("; ")}`;
}

/** A loopback, private, carrier-grade NAT, link-local or unique-local address (IPv4 or IPv6, literal) */
export function isPrivateAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "::" || h === "0.0.0.0") return true;
  if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h)) return true;
  return h.includes(":") && (/^(fc|fd|fe8|fe9|fea|feb)/.test(h) || h.startsWith("::ffff:"));
}

/**
 * An Agent Card URL the buyer may fetch: https to a public host name or address. Loopback, private and link-local
 * addresses written as literals are refused here; `cardHostIsPublic` also checks what a host name resolves to.
 */
export function cardUrlAllowed(url: string, allowLocalHttp = false): void {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error(`agent_uri is not a URL: ${url.slice(0, 80)}`); }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const local = host === "localhost" || host.endsWith(".localhost") || /^127\./.test(host) || host === "::1";
  if (allowLocalHttp && u.protocol === "http:" && local) return;
  if (u.protocol !== "https:") throw new Error(`agent_uri is not https: ${url.slice(0, 80)}`);
  if (isPrivateAddress(host)) throw new Error(`agent_uri points at a local or private address: ${host}`);
}

/**
 * A host name in an on-chain agent_uri must not resolve to a private address either (the owner can point its name anywhere).
 * A name that does not resolve is left to the fetch, which then fails. (DNS can still change between this lookup and the fetch.)
 */
export async function cardHostIsPublic(url: string): Promise<void> {
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(host) || host.includes(":")) return; // literals were checked by cardUrlAllowed
  let addrs: { address: string }[];
  try { addrs = await (await import("node:dns/promises")).lookup(host, { all: true, verbatim: true }); } catch { return; }
  const bad = addrs.find((a) => isPrivateAddress(a.address));
  if (bad) throw new Error(`agent_uri host ${host} resolves to a private address`);
}

/** Same Concordium account, aliases included; false for anything that is not an account address */
export function sameAccountSafe(a: string, b: string): boolean {
  try {
    return Buffer.from(AccountAddress.fromBase58(a).decodedAddress).subarray(0, 29).equals(Buffer.from(AccountAddress.fromBase58(b).decodedAddress).subarray(0, 29));
  } catch {
    return false;
  }
}
