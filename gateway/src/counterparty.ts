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
import type { AgentOnChain } from "./registry-node.js";
import { NET } from "./network.js";
import { createHash } from "node:crypto";
import type { Check } from "./verify.js";

export const BADGE_EXTENSION = "https://docs.concordium.com/a2a-extensions/concordium-badge/v1";
/** x402 PaymentRequired 的頂層擴充欄位：指名收款的 agent（只是指標，錢包從鏈上讀） */
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

/** Agent Card 裡 badge 的 token address（"ccd:<genesis>/cis-2:JyP9…" → "JyP9…"） */
/** Agent Card 最大 64 KiB：賣方回傳超大或不停的內容時，買方不會被拖住 */
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
  /** 直接向節點讀 CIS-8004 的 agent 紀錄；有的話，狀態、card 位置與雜湊、收款錢包都以節點讀到的為準 */
  readAgent?: (tokenId: string) => Promise<AgentOnChain | null>;
  /** 402 回應的 concordium-agent 擴充欄位指名的 agent 與 badge（有的話必須一致） */
  expectTokenId?: string;
  expectBadge?: string;
  /** 收款地址不在 Concordium 上（例如 Base 的 USDC）時，用這個檢查取代「payTo＝agentWallet」；收到節點讀到的擁有者與錢包 */
  payToCheck?: (agent: { owner?: string; wallet?: string }) => Promise<Check>;
}): Promise<SellerVerdict> {
  const f = opts.fetch ?? fetch;
  const network = opts.network ?? NET.name;
  const checks: Check[] = [];
  const out: SellerVerdict = { ok: false, checks, payTo: opts.payTo };
  const done = () => ({ ...out, ok: checks.length === 5 && checks.every((c) => c.ok) });
  const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

  // 1. 賣方網站宣告的 badge
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

  // 2. Registry 上的紀錄
  let rec: { token_id?: string; owner_account?: string; agent_uri?: string; metadata_hash_hex?: string; agent_wallet?: string; status?: string };
  try {
    rec = await opts.registry("agent_by_token_address", { network, token_address: tokenAddress });
  } catch (e) {
    checks.push({ name: "registered and Active in the CIS-8004 Agent Registry", ok: false, detail: `registry unreachable: ${err(e)}` });
    return done();
  }
  // 託管服務只用來從 badge 找到 token id；紀錄本身直接向節點讀，兩者不一致就不付
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

  // 3. 官方 badge 檢查
  try {
    const b = await opts.registry("check_badge", { network, id: tokenAddress });
    const failed = Object.entries(b?.checks ?? {}).filter(([, v]) => v === false).map(([k]) => k);
    checks.push({
      name: "official badge check passes (identity-verified owner)",
      ok: b?.badge_valid === true,
      detail: b?.badge_valid ? `${Object.keys(b.checks ?? {}).length} checks passed` : `failed: ${[...failed, ...((b?.issues ?? []) as unknown[]).map((i) => (typeof i === "string" ? i : (i as { field?: string; message?: string })?.message ? `${(i as { field?: string }).field ?? ""}: ${(i as { message: string }).message}` : JSON.stringify(i)))].join(", ") || "badge not valid"}`,
    });
  } catch (e) {
    checks.push({ name: "official badge check passes (identity-verified owner)", ok: false, detail: `registry unreachable: ${err(e)}` });
  }

  // 4. 自己下載 card、自己算雜湊
  try {
    if (!rec.agent_uri) throw new Error("no agent_uri on-chain");
    // https only (plain http allowed only for a local test server)
    if (!/^https:\/\//.test(rec.agent_uri) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(rec.agent_uri))
      throw new Error(`agent_uri is not https: ${rec.agent_uri.slice(0, 80)}`);
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

  // 5. 收款地址綁定
  if (opts.payToCheck) {
    try {
      checks.push(await opts.payToCheck({ owner: rec.owner_account, wallet: rec.agent_wallet }));
    } catch (e) {
      checks.push({ name: "payTo is bound to the agent on-chain", ok: false, detail: err(e) });
    }
    return done();
  }
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
    ? `seller verified: agent #${v.tokenId} (${v.tokenAddress}), owner ${v.owner}, ${v.checks[4]?.name.includes("CIS-8") ? "paying an EVM address bound to it in CIS-8" : "paying its on-chain wallet"}`
    : `refused to pay: ${bad.map((c) => `${c.name} — ${c.detail}`).join("; ")}`;
}
