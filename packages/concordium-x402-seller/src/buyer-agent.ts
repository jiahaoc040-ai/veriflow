/**
 * The seller checks the buyer's agent
 * -----------------------------------
 * A buyer agent names its CIS-8004 token id in the X-Concordium-Agent request header. The header needs no signature of its own:
 * the payment is signed by the buyer's account, and the seller reads agentOf(token id) from a Concordium node, requiring the agent
 * to be Active and its on-chain agentWallet to be the paying account. Nobody can borrow an agent's name without paying from its wallet.
 *
 * Policy: "off" (ignore), "optional" (check when named, refuse if the check fails, sell when not named), "required" (registered agents only).
 */
import { sameAccount, type AgentOnChain } from "concordium-x402-guard";

export const BUYER_AGENT_HEADER = "x-concordium-agent";
export type BuyerAgentPolicy = "off" | "optional" | "required";

export type BuyerAgentResult =
  | { ok: true; named: false }
  | { ok: true; named: true; tokenId: string; owner: string; wallet: string }
  | { ok: false; code: string; reason: string };

export async function checkBuyerAgent(
  header: string | undefined,
  payer: string | undefined,
  policy: BuyerAgentPolicy,
  readAgent: (tokenId: string) => Promise<AgentOnChain | null>,
): Promise<BuyerAgentResult> {
  if (policy === "off") return { ok: true, named: false };
  const tokenId = header?.trim();
  if (!tokenId)
    return policy === "required"
      ? { ok: false, code: "missing", reason: `this seller only sells to agents registered in the Concordium Agent Registry; send your token id in the ${BUYER_AGENT_HEADER} header` }
      : { ok: true, named: false };
  if (!/^\d{1,20}$/.test(tokenId)) return { ok: false, code: "bad_id", reason: `${BUYER_AGENT_HEADER} must be a CIS-8004 token id (digits)` };
  if (!payer) return { ok: false, code: "no_payer", reason: "no payer in the payment" };
  let node: AgentOnChain | null;
  try {
    node = await readAgent(tokenId);
  } catch {
    return { ok: false, code: "node_error", reason: `could not read agent #${tokenId} from a Concordium node` };
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
