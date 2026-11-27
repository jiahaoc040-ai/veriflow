/** Where the Concordium pieces live on each network (addresses published by Concordium) */
export type NetworkName = "testnet" | "mainnet";

export type ConcordiumNetwork = {
  name: NetworkName;
  /** CAIP-2 id used by x402 for this network (typed the way @x402/core's register() and routes expect it) */
  caip2: `${string}:${string}`;
  /** CIS-8004 Agent Registry */
  agentRegistry: { index: bigint; subindex: bigint };
  /** CIS-8 External Key Registry */
  cis8Registry: { index: bigint; subindex: bigint };
  /** Public gRPC node */
  grpc: { host: string; port: number };
  /** EVM network whose keys agents usually bind (Base) */
  evmNetwork: `${string}:${string}`;
};

export const NETWORKS: Record<NetworkName, ConcordiumNetwork> = {
  testnet: {
    name: "testnet",
    caip2: "ccd:4221332d34e1694168c2a0c0b3fd0f27",
    agentRegistry: { index: 12802n, subindex: 0n },
    cis8Registry: { index: 12801n, subindex: 0n },
    grpc: { host: "grpc.testnet.concordium.com", port: 20000 },
    evmNetwork: "eip155:84532",
  },
  mainnet: {
    name: "mainnet",
    caip2: "ccd:9dd9ca4d19e9393877d2c44b70f89acb",
    agentRegistry: { index: 10082n, subindex: 0n },
    cis8Registry: { index: 10081n, subindex: 0n },
    grpc: { host: "grpc.mainnet.concordium.software", port: 20000 },
    evmNetwork: "eip155:8453",
  },
};
