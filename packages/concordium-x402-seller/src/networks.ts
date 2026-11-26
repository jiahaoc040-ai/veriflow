/** The Concordium network a seller runs on: the guard's published addresses plus the DID network name Verify & Access uses */
import { NETWORKS as GUARD_NETWORKS, type NetworkName } from "concordium-x402-guard";

export type { NetworkName };
export type SellerNetwork = (typeof GUARD_NETWORKS)[NetworkName] & { did: "Testnet" | "Mainnet" };

export const NETWORKS: Record<NetworkName, SellerNetwork> = {
  testnet: { ...GUARD_NETWORKS.testnet, did: "Testnet" },
  mainnet: { ...GUARD_NETWORKS.mainnet, did: "Mainnet" },
};

export function network(name: string | undefined): SellerNetwork {
  const n = name ?? "testnet";
  if (!Object.prototype.hasOwnProperty.call(NETWORKS, n)) throw new Error(`network must be "testnet" or "mainnet", got ${JSON.stringify(n)}`);
  return NETWORKS[n as NetworkName];
}
