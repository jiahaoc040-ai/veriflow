/**
 * 付款前驗證賣方（買方 agent 用）
 * ------------------------------
 * 賣方用零知識證明檢查買方；這裡是反方向：買方付錢之前，先確認收款的那一方是誰。
 * 全部向 Concordium 官方的 Agent Registry（CIS-8004 <12802,0>，透過官方 hosted MCP）查，不信任賣方自己的說法：
 *
 *   1. 賣方網站的 Agent Card 宣告了 Verified by Concordium badge
 *   2. 這個 badge 在 Registry 上存在、狀態 Active
 *   3. 官方 check_badge 全部通過（擁有者是通過身份驗證的真人、card 結構正確…）
 *   4. 我們自己下載 Agent Card、自己算 SHA-256，等於鏈上釘住的 metadata_hash（card 沒被換過）
 *   5. x402 要我們付款的地址（payTo）＝鏈上登記的 agentWallet——
 *      擋掉「抄別人的 badge、但把錢收到自己地址」的冒充者
 *
 * 任何一項不過就不付款（fail closed）。Registry 連不到也一樣不付。
 */
import { createHash } from "node:crypto";
import type { Check } from "./verify.js";

export const BADGE_EXTENSION = "https://docs.concordium.com/a2a-extensions/concordium-badge/v1";

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

/** Agent Card 裡 badge 的 token address（"ccd:<genesis>/cis-2:JyP9…" → "JyP9…"） */
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
}): Promise<SellerVerdict> {
  const f = opts.fetch ?? fetch;
  const network = opts.network ?? "testnet";
  const checks: Check[] = [];
  const out: SellerVerdict = { ok: false, checks, payTo: opts.payTo };
  const done = () => ({ ...out, ok: checks.length === 5 && checks.every((c) => c.ok) });
  const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // 1. 賣方網站宣告的 badge
  let tokenAddress: string | undefined;
  try {
    const r = await f(`${opts.gateway}/.well-known/agent-card.json`);
    tokenAddress = r.ok ? badgeTokenAddress(await r.json()) : undefined;
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

  // 2. Registry 上的紀錄
  let rec: { token_id?: string; owner_account?: string; agent_uri?: string; metadata_hash_hex?: string; agent_wallet?: string; status?: string };
  try {
    rec = await opts.registry("agent_by_token_address", { network, token_address: tokenAddress });
  } catch (e) {
    checks.push({ name: "registered and Active in the CIS-8004 Agent Registry", ok: false, detail: `registry unreachable: ${err(e)}` });
    return done();
  }
  out.tokenId = rec.token_id;
  out.owner = rec.owner_account;
  out.agentWallet = rec.agent_wallet;
  checks.push({
    name: "registered and Active in the CIS-8004 Agent Registry",
    ok: rec.status === "Active",
    detail: `agent #${rec.token_id ?? "?"}, status ${rec.status ?? "not found"}, owner ${rec.owner_account ?? "?"}`,
  });

  // 3. 官方 badge 檢查
  try {
    const b = await opts.registry("check_badge", { network, id: tokenAddress });
    const failed = Object.entries(b?.checks ?? {}).filter(([, v]) => v === false).map(([k]) => k);
    checks.push({
      name: "official badge check passes (identity-verified owner)",
      ok: b?.badge_valid === true,
      detail: b?.badge_valid ? `${Object.keys(b.checks ?? {}).length} checks passed` : `failed: ${[...failed, ...(b?.issues ?? [])].join(", ") || "badge not valid"}`,
    });
  } catch (e) {
    checks.push({ name: "official badge check passes (identity-verified owner)", ok: false, detail: `registry unreachable: ${err(e)}` });
  }

  // 4. 自己下載 card、自己算雜湊
  try {
    if (!rec.agent_uri) throw new Error("no agent_uri on-chain");
    const r = await f(rec.agent_uri);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const sha = createHash("sha256").update(Buffer.from(await r.arrayBuffer())).digest("hex");
    checks.push({
      name: "Agent Card unchanged since pinned on-chain (own SHA-256)",
      ok: !!rec.metadata_hash_hex && sha === rec.metadata_hash_hex.toLowerCase(),
      detail: `sha256 ${sha} vs on-chain ${rec.metadata_hash_hex ?? "none"}`,
    });
  } catch (e) {
    checks.push({ name: "Agent Card unchanged since pinned on-chain (own SHA-256)", ok: false, detail: err(e) });
  }

  // 5. 收款地址綁定
  checks.push({
    name: "payTo is the agent's on-chain wallet",
    ok: !!rec.agent_wallet && rec.agent_wallet === opts.payTo,
    detail: `payTo ${opts.payTo}, on-chain agentWallet ${rec.agent_wallet || "not set"}`,
  });
  return done();
}

/** 給人看的一行摘要 */
export function summarize(v: SellerVerdict): string {
  const bad = v.checks.filter((c) => !c.ok);
  return v.ok
    ? `seller verified: agent #${v.tokenId} (${v.tokenAddress}), owner ${v.owner}, paying its on-chain wallet`
    : `refused to pay: ${bad.map((c) => `${c.name} — ${c.detail}`).join("; ")}`;
}
