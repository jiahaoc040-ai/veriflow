/**
 * On-chain monitor (GitHub Actions, daily): fails (red) if anything differs from what is expected
 * ----------------------------------------------------------------
 *   - Agent #1313 (CIS-8004 <12802,0>, read from a node): Active, payout wallet, Agent Card location and hash, owner
 *   - Contract v2 <13115,0>: owner, committer
 *   - Live 402: payTo equals the on-chain wallet, and concordium-agent names #1313 with the same badge
 * Only the cold wallet 4dNM can change these values; if this turns red and you did not do it, someone has the owner key:
 * immediately run revoke_committer with 4dNM and set the agent to Revoked.
 *
 *   npm run watch
 */
import { ContractAddress } from "@concordium/web-sdk";
import { readAgent } from "./registry-node.js";
import { PUBLIC_GATEWAY } from "./mcp-launch.js";
import { createV2Reader, TESTNET_REGISTRY_V2_INDEX, v2Address } from "./contract-v2.js";
import { isMain } from "./is-main.js";

export const EXPECTED = {
  agent: {
    tokenId: "1313",
    owner: "4dNMXmNKa2i5hvABfbRJ6NebGopaWSPNmMrbvroSzgJF5wjUNt",
    wallet: "3WSAJwTZqVRypnGMkUjW28QDES8h1FUBoCwrzQ1rdN35NGavf8",
    agentUri: "https://raw.githubusercontent.com/jiahaoc040-ai/veriflow/main/agent-card.json",
    metadataHash: "ee656d25819f55fa5ce9f01ad729e978bd1f15616d1b6e2947fc324972d5fec9",
    status: "Active",
  },
  badge: "JyP9UWYKh54TD2MUJDfqC",
  contractV2: { owner: "4dNMXmNKa2i5hvABfbRJ6NebGopaWSPNmMrbvroSzgJF5wjUNt", committer: "4HgaCRwXHYWLAbHA4NE5LD8Cv8xYvuW4hP6RACaT1xVwT3nmCj" },
};

export function compare(name: string, want: Record<string, unknown>, got: Record<string, unknown> | null): string[] {
  if (!got) return [`${name}: not found on-chain`];
  return Object.entries(want).filter(([k, v]) => got[k] !== v).map(([k, v]) => `${name}.${k}: expected ${String(v)}, on-chain ${String(got[k])}`);
}

async function main() {
  const agent = await readAgent(EXPECTED.agent.tokenId);
  const v2 = await createV2Reader(v2Address() ?? ContractAddress.create(TESTNET_REGISTRY_V2_INDEX, 0n)).summary();
  const problems = [...compare("agent", EXPECTED.agent, agent), ...compare("contractV2", EXPECTED.contractV2, v2)];
  // Live 402: the payout address must be the on-chain wallet, and it must name #1313
  try {
    const { decodePaymentRequiredHeader } = await import("@x402/core/http");
    const r = await fetch(`${PUBLIC_GATEWAY}/signal/BTC`, { signal: AbortSignal.timeout(60_000) });
    const h = r.headers.get("PAYMENT-REQUIRED");
    if (r.status !== 402 || !h) problems.push(`live 402: HTTP ${r.status}`);
    else {
      const pr = decodePaymentRequiredHeader(h) as { accepts: { payTo: string }[]; extensions?: Record<string, { info?: { tokenId?: string; badge?: string } }> };
      const info = pr.extensions?.["concordium-agent"]?.info;
      if (pr.accepts[0]?.payTo !== agent?.wallet) problems.push(`live 402: payTo ${pr.accepts[0]?.payTo} is not the on-chain wallet ${agent?.wallet}`);
      if (info?.tokenId !== EXPECTED.agent.tokenId || info?.badge !== EXPECTED.badge) problems.push(`live 402: concordium-agent names #${info?.tokenId} ${info?.badge}`);
    }
  } catch (e) {
    problems.push(`live 402 unreachable: ${e instanceof Error ? e.message : e}`);
  }
  console.log(JSON.stringify({ agent, contractV2: { owner: v2.owner, committer: v2.committer, issued: v2.issued, revealed: v2.revealed } }, null, 2));
  if (problems.length) {
    console.error(`❌ on-chain state changed:\n  ${problems.join("\n  ")}\nIf you did not make this change, revoke the committer and the agent with the cold owner key now.`);
    process.exit(1);
  }
  console.log("✅ agent #1313 and contract v2 are as expected");
}

if (isMain(import.meta.url)) {
  main().then(() => process.exit(0), (e) => {
    console.error(`❌ ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
