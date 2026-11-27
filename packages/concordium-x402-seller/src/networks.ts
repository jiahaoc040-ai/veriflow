/** The Concordium network a seller runs on: the guard's published addresses plus the DID network name Verify & Access uses */
import { NETWORKS as GUARD_NETWORKS, type NetworkName } from "concordium-x402-guard";

export type { NetworkName };
/** caip2 typed the way @x402/core's register() and routes expect it */
export type SellerNetwork = Omit<(typeof GUARD_NETWORKS)[NetworkName], "caip2"> & { caip2: `${string}:${string}`; did: "Testnet" | "Mainnet" };

export const NETWORKS: Record<NetworkName, SellerNetwork> = {
  testnet: { ...GUARD_NETWORKS.testnet, caip2: GUARD_NETWORKS.testnet.caip2 as `${string}:${string}`, did: "Testnet" },
  mainnet: { ...GUARD_NETWORKS.mainnet, caip2: GUARD_NETWORKS.mainnet.caip2 as `${string}:${string}`, did: "Mainnet" },
};

export function network(name: string | undefined): SellerNetwork {
  const n = name ?? "testnet";
  if (!Object.prototype.hasOwnProperty.call(NETWORKS, n)) throw new Error(`network must be "testnet" or "mainnet", got ${JSON.stringify(n)}`);
  return NETWORKS[n as NetworkName];
}
