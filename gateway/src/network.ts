/**
 * All network settings live here: CONCORDIUM_NETWORK=testnet (default) or mainnet
 * ----------------------------------------------------------------
 * Every network-dependent value comes from this set: x402's CAIP-2, the Verify & Access DID network,
 * the Agent Registry network name and contract addresses, explorer links. The genesis for setAgentWallet is not hard-coded:
 * it is read from the node, whose first 32 characters must equal the CAIP-2 (so the wrong node or chain is never signed for).
 * A test checks that no other file hard-codes "Testnet", "ccdexplorer.io/testnet" or the CAIP-2.
 */
import "./env-file.js"; // read .env first, so CONCORDIUM_NETWORK set in .env takes effect
import { CONCORDIUM_MAINNET_CAIP2, CONCORDIUM_TESTNET_CAIP2 } from "@x402/concordium";

export type NetworkName = "testnet" | "mainnet";

export const NETWORKS = {
  // evm: the EVM network for cross-chain USDC (testnet = Base Sepolia, mainnet = Base). agentRegistry: the CIS-8004 contract; cis8Registry: the CIS-8 External Key Registry (binds other chains' public keys to Concordium accounts). Testnet values come from the official badge check; mainnet from the Agent Registry page on docs.concordium.com (10082,0)
  testnet: { name: "testnet", did: "Testnet", caip2: CONCORDIUM_TESTNET_CAIP2, explorer: "https://ccdexplorer.io/testnet", agentRegistry: { index: 12802n, subindex: 0n }, cis8Registry: { index: 12801n, subindex: 0n }, evm: { network: "eip155:84532", explorer: "https://sepolia.basescan.org", rpc: "https://sepolia.base.org" } },
  mainnet: { name: "mainnet", did: "Mainnet", caip2: CONCORDIUM_MAINNET_CAIP2, explorer: "https://ccdexplorer.io/mainnet", agentRegistry: { index: 10082n, subindex: 0n }, cis8Registry: { index: 10081n, subindex: 0n }, evm: { network: "eip155:8453", explorer: "https://basescan.org", rpc: "https://mainnet.base.org" } },
} as const;

export function selectNetwork(v = process.env.CONCORDIUM_NETWORK ?? "testnet") {
  if (v !== "testnet" && v !== "mainnet") throw new Error(`CONCORDIUM_NETWORK must be testnet or mainnet, not ${v}`);
  return NETWORKS[v];
}

export const NET = selectNetwork();
export const txLink = (hash: string) => `${NET.explorer}/transaction/${hash}`;

/** The node's genesis must belong to the selected network */
export function checkGenesis(genesisHex: string, net = NET) {
  const want = String(net.caip2).split(":")[1];
  if (!genesisHex.startsWith(want)) throw new Error(`node genesis ${genesisHex.slice(0, 32)}… is not ${net.name} (${net.caip2})`);
  return genesisHex;
}
