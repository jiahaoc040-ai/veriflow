/**
 * Write a signal's commitment hash to Concordium (register-data transaction, no smart contract needed; v1)
 * -------------------------------------------------------------------
 * On-chain data format (UTF-8 text, readable directly on ccdexplorer):
 *   veriflow:v1:<64-character SHA-256 commitment hash>
 *
 * Send only, without waiting for finalization (about 10 s), so the buyer is not slowed down; the transaction hash returns immediately.
 *
 * With REGISTRY_CONTRACT set, commits go to the VeriFlow smart contract (contract/) instead:
 * the chain enforces that only the seller can write and nothing is overwritten; after the horizon anyone can reveal and the chain checks the hash.
 * read() turns the contract's Committed events into the same veriflow:v1:<hash> form, so verification does not change.
 */
import { createGrpc } from "./grpc.js";
import {
  AccountAddress,
  BlockHash,
  ConcordiumGRPCClient,
  ContractAddress,
  DataBlob,
  SequenceNumber,
  TransactionExpiry,
  TransactionHash,
  TransactionStatusEnum,
} from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";
import { loadAccount } from "./config.js";
import { forgetNonce, pickNonce, serialize } from "./txqueue.js";
import { createRegistryClient, decodeCommittedEvent, registryAddress } from "./contract.js";
import { decodeCommittedEventV2, TESTNET_REGISTRY_V2_INDEX, v2Address } from "./contract-v2.js";

import { ANCHOR_PREFIX } from "./anchor-format.js";
export { ANCHOR_PREFIX };

export function anchorPayload(commitment: string): ArrayBuffer {
  if (!/^[0-9a-f]{64}$/.test(commitment)) throw new Error(`malformed commitment: ${commitment}`);
  return new TextEncoder().encode(ANCHOR_PREFIX + commitment).buffer as ArrayBuffer;
}

export function createAnchorer(keyFile: string) {
  const account = loadAccount(keyFile);
  const grpc = createGrpc();
  const registry = registryAddress();
  const registryClient = registry ? createRegistryClient(keyFile, registry) : undefined;

  return {
    address: account.address,
    mode: registry ? `contract <${registry.index},${registry.subindex}>` : "register data",

    /** Read an anchor transaction back from the chain (see readAnchorTx) */
    read: (txHash: string) => readAnchorTx(grpc, txHash, registry),

    /** Current balance of the operator account (anchoring, fee sponsoring), in microCCD */
    async balanceMicroCcd(): Promise<bigint> {
      return (await grpc.getAccountInfo(account.accountAddress)).accountAmount.microCcdAmount;
    },

    /** Contract mode only: look up a commitment's record in the contract, reveal its content after the horizon (the contract recomputes the hash) */
    contract: registryClient
      ? { record: (commitment: string) => registryClient.commitment(commitment), reveal: (canonical: string) => registryClient.reveal(canonical) }
      : undefined,
    async anchor(commitment: string, asset = "BTC"): Promise<string> {
      if (registryClient) {
        anchorPayload(commitment); // format check
        return registryClient.commit(commitment, asset);
      }
      const data = anchorPayload(commitment);
      // The operator account's transactions are queued so nonces never collide (see txqueue.ts)
      return serialize(account.address, async () => {
        const fromNode = (await grpc.getNextAccountNonce(account.accountAddress)).nonce.value;
        const tx = Transaction.registerData({ data: new DataBlob(data) })
          .addMetadata({
            sender: account.accountAddress,
            nonce: SequenceNumber.create(pickNonce(account.address, fromNode)),
            expiry: TransactionExpiry.futureMinutes(5),
          })
          .build();
        try {
          const hash = await grpc.sendTransaction(await Transaction.signAndFinalize(tx, account.signer));
          return TransactionHash.toHexString(hash);
        } catch (e) {
          forgetNonce(account.address);
          throw e;
        }
      });
    },
  };
}

/** An anchor transaction read back from Concordium */
export type OnChainAnchor = {
  tx: string;
  status: string; // "pending" | "committed" | "finalized"
  block_hash?: string | null;
  block_time?: string | null; // block time (ISO, UTC): proves when it was anchored
  sender?: string | null;
  transaction_type?: string | null;
  data_hex?: string | null;
  data_text?: string | null;
  /** Contract v2 commitment: which contract, which (asset, as_of) */
  contract?: string;
  asset?: string;
  as_of?: string;
};

/**
 * Read an anchor transaction back from the chain: status, block time, sender, data (hex and decoded text).
 * No private key needed — the buyer's agent (MCP verify_signal) uses it against a Concordium node directly, without trusting the seller's server.
 * Contract mode: only Committed events emitted by the given contract (registry) count, turned into the same veriflow:v1:<hash> form.
 */
export async function readAnchorTx(
  grpc: ConcordiumGRPCClient,
  txHash: string,
  registry?: ContractAddress.Type,
  registryV2?: ContractAddress.Type,
): Promise<OnChainAnchor> {
  const status = await grpc.getBlockItemStatus(TransactionHash.fromHexString(txHash));
  if (status.status === TransactionStatusEnum.Received) return { tx: txHash, status: "pending" };
  const outcome = status.status === TransactionStatusEnum.Finalized ? status.outcome : status.outcomes[0];
  const s = outcome?.summary as any;
  let dataHex: string | undefined = s?.dataRegistered?.data;
  let key: { contract: string; asset: string; as_of: string } | undefined;
  if (!dataHex && registry && s?.transactionType === "update") {
    for (const e of contractEventsOf(s, registry.index)) {
      const ev = decodeCommittedEvent(e);
      if (ev) dataHex = Buffer.from(ANCHOR_PREFIX + ev.commitment, "utf8").toString("hex");
    }
  }
  // Contract v2: Committed events carry (asset, as_of); the contract already guarantees one per key, committed within a day of the close
  const v2 = registryV2 ?? v2Address() ?? ContractAddress.create(TESTNET_REGISTRY_V2_INDEX, 0n);
  if (!dataHex && s?.transactionType === "update") {
    for (const e of contractEventsOf(s, v2.index)) {
      const ev = decodeCommittedEventV2(e);
      if (ev) {
        dataHex = Buffer.from(ANCHOR_PREFIX + ev.commitment, "utf8").toString("hex");
        key = { contract: `<${v2.index},${v2.subindex}>`, asset: ev.asset, as_of: ev.as_of };
      }
    }
  }
  const blockTime = outcome ? (await grpc.getBlockInfo(outcome.blockHash)).blockSlotTime.toISOString() : null;
  return {
    tx: txHash,
    status: status.status, // "finalized" | "committed"
    block_hash: outcome ? BlockHash.toHexString(outcome.blockHash) : null,
    block_time: blockTime,
    sender: s?.sender ? AccountAddress.toBase58(s.sender) : null,
    transaction_type: s?.transactionType ?? null,
    data_hex: dataHex ?? null,
    data_text: dataHex ? Buffer.from(dataHex, "hex").toString("utf8") : null,
    ...(key ?? {}),
  };
}

/** Events of the given contract in a transaction summary (hex) */
function contractEventsOf(summary: any, contractIndex: bigint): string[] {
  const out: string[] = [];
  for (const ev of summary?.events ?? []) {
    if (ev?.address?.index !== contractIndex) continue;
    for (const e of ev.events ?? []) {
      if (typeof e === "string") out.push(e);
      else if (e?.buffer instanceof Uint8Array) out.push(Buffer.from(e.buffer).toString("hex"));
    }
  }
  return out;
}
