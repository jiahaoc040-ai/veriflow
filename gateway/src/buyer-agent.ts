/**
 * 賣方驗證買方 agent（雙向的代理互信）
 * ------------------------------------
 * 買方在請求標頭 X-Concordium-Agent 寫上自己在 CIS-8004 Agent Registry 的 token id。
 * 這個標頭只是「指名」，不需要另外簽名：付款交易本身由買方帳號簽名，賣方從節點讀 agentOf(token id)，
 * 要求這個 agent 是 Active，而且它在鏈上綁定的 agentWallet 就是這筆付款的付款帳號。
 * 所以別人不能冒用某個 agent 的身分：除非用那個 agent 的錢包付款，否則對不上。
 *
 * BUYER_AGENT 政策：off（不看）、optional（有指名就驗證，驗證不過就拒絕；沒指名照賣）、required（一定要是已登記的 agent）
 */
import { sameAccount } from "./contract-v2.js";
import type { AgentOnChain } from "./registry-node.js";

export const BUYER_AGENT_HEADER = "x-concordium-agent";
export type BuyerAgentPolicy = "off" | "optional" | "required";

export type BuyerAgentResult =
  | { ok: true; named: false }
  | { ok: true; named: true; tokenId: string; owner: string; wallet: string }
  | { ok: false; reason: string };

export function parsePolicy(v: string | undefined): BuyerAgentPolicy {
  return v === "off" || v === "required" ? v : "optional";
}

export async function checkBuyerAgent(
  header: string | undefined,
  payer: string | undefined,
  policy: BuyerAgentPolicy,
  readAgent: (tokenId: string) => Promise<AgentOnChain | null>,
): Promise<BuyerAgentResult> {
  if (policy === "off") return { ok: true, named: false };
  const tokenId = header?.trim();
  if (!tokenId) return policy === "required" ? { ok: false, reason: `this seller only sells to agents registered in the Concordium Agent Registry; send your token id in the ${BUYER_AGENT_HEADER} header` } : { ok: true, named: false };
  if (!/^\d{1,20}$/.test(tokenId)) return { ok: false, reason: `${BUYER_AGENT_HEADER} must be a CIS-8004 token id (digits)` };
  if (!payer) return { ok: false, reason: "no payer in the payment" };
  let node: AgentOnChain | null;
  try {
    node = await readAgent(tokenId);
  } catch (e) {
    return { ok: false, reason: `could not read agent #${tokenId} from a Concordium node: ${e instanceof Error ? e.message : e}` };
  }
  if (!node) return { ok: false, reason: `agent #${tokenId} is not in the Agent Registry` };
  if (node.tokenId !== tokenId) return { ok: false, reason: `registry returned agent #${node.tokenId} for #${tokenId}` };
  if (node.status !== "Active") return { ok: false, reason: `agent #${tokenId} is ${node.status}` };
  if (!node.wallet) return { ok: false, reason: `agent #${tokenId} has no agentWallet bound on-chain` };
  let same = false;
  try { same = sameAccount(node.wallet, payer); } catch { same = false; }
  if (!same) return { ok: false, reason: `the payment comes from ${payer}, but agent #${tokenId}'s on-chain agentWallet is ${node.wallet}` };
  return { ok: true, named: true, tokenId, owner: node.owner, wallet: node.wallet };
}
