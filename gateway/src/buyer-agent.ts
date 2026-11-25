/**
 * The seller verifies the buyer's agent (trust between agents in both directions)
 * ------------------------------------
 * The buyer puts its CIS-8004 Agent Registry token id in the X-Concordium-Agent request header.
 * The header only names the agent and needs no extra signature: the payment itself is signed by the buyer's account, and the seller reads agentOf(token id) from a node,
 * requiring the agent to be Active and its on-chain agentWallet to be the account paying.
 * So nobody can borrow an agent's identity: unless they pay from that agent's wallet, it does not match.
 *
 * BUYER_AGENT policy: off (ignore), optional (check when named and refuse if the check fails; sell when not named), required (registered agents only)
 */
import { sameAccount } from "./contract-v2.js";
import type { AgentOnChain } from "./registry-node.js";

export const BUYER_AGENT_HEADER = "x-concordium-agent";
export type BuyerAgentPolicy = "off" | "optional" | "required";

export type BuyerAgentResult =
  | { ok: true; named: false }
  | { ok: true; named: true; tokenId: string; owner: string; wallet: string }
  | { ok: false; code: string; reason: string };

export function parsePolicy(v: string | undefined): BuyerAgentPolicy {
  const p = (v ?? "").trim().toLowerCase();
  return p === "off" || p === "required" ? p : "optional";
}

export async function checkBuyerAgent(
  header: string | undefined,
  payer: string | undefined,
  policy: BuyerAgentPolicy,
  readAgent: (tokenId: string) => Promise<AgentOnChain | null>,
): Promise<BuyerAgentResult> {
  if (policy === "off") return { ok: true, named: false };
  const tokenId = header?.trim();
  if (!tokenId) return policy === "required" ? { ok: false, code: "missing", reason: `this seller only sells to agents registered in the Concordium Agent Registry; send your token id in the ${BUYER_AGENT_HEADER} header` } : { ok: true, named: false };
  if (!/^\d{1,20}$/.test(tokenId)) return { ok: false, code: "bad_id", reason: `${BUYER_AGENT_HEADER} must be a CIS-8004 token id (digits)` };
  if (!payer) return { ok: false, code: "no_payer", reason: "no payer in the payment" };
  let node: AgentOnChain | null;
  try {
    node = await readAgent(tokenId);
  } catch (e) {
    return { ok: false, code: "node_error", reason: `could not read agent #${tokenId} from a Concordium node: ${e instanceof Error ? e.message : e}` };
  }
  if (!node) return { ok: false, code: "not_found", reason: `agent #${tokenId} is not in the Agent Registry` };
  if (node.tokenId !== tokenId) return { ok: false, code: "id_mismatch", reason: `registry returned agent #${node.tokenId} for #${tokenId}` };
  if (node.status !== "Active") return { ok: false, code: "not_active", reason: `agent #${tokenId} is ${node.status}` };
  if (!node.wallet) return { ok: false, code: "no_wallet", reason: `agent #${tokenId} has no agentWallet bound on-chain` };
  let same = false;
  try { same = sameAccount(node.wallet, payer); } catch { same = false; }
  if (!same) return { ok: false, code: "wallet_mismatch", reason: `the payment comes from ${payer}, but agent #${tokenId}'s on-chain agentWallet is ${node.wallet}` };
  return { ok: true, named: true, tokenId, owner: node.owner, wallet: node.wallet };
}
