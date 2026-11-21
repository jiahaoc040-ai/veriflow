/**
 * 把訊號的承諾雜湊寫上 Concordium（register data 交易，不需要智能合約）
 * -------------------------------------------------------------------
 * 鏈上資料格式（UTF-8 文字，ccdexplorer 上可以直接看到）：
 *   veriflow:v1:<64 字元 SHA-256 承諾雜湊>
 *
 * 只送出、不等最終確認（約 10 秒），避免拖慢買方拿訊號；交易 hash 會立刻回傳。
 *
 * 設定 REGISTRY_CONTRACT 後改用 VeriFlow 智能合約（contract/）的 commit：
 * 鏈上強制只有賣方能寫、不能覆蓋，期滿後任何人都能公開並由鏈上驗證雜湊。
 * read() 會把合約的 Committed 事件轉成同樣的 veriflow:v1:<hash> 格式，所以驗證流程不用改。
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

import { ANCHOR_PREFIX } from "./anchor-format.js";
export { ANCHOR_PREFIX };

export function anchorPayload(commitment: string): ArrayBuffer {
  if (!/^[0-9a-f]{64}$/.test(commitment)) throw new Error(`commitment 格式錯誤：${commitment}`);
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

    /** 從鏈上讀回一筆上鏈交易（見 readAnchorTx） */
    read: (txHash: string) => readAnchorTx(grpc, txHash, registry),

    /** 營運帳號（上鏈、贊助手續費）目前的餘額，單位 microCCD */
    async balanceMicroCcd(): Promise<bigint> {
      return (await grpc.getAccountInfo(account.accountAddress)).accountAmount.microCcdAmount;
    },

    /** 合約模式才有：查某個承諾在合約裡的紀錄、到期後公開內容（合約自己重算雜湊） */
    contract: registryClient
      ? { record: (commitment: string) => registryClient.commitment(commitment), reveal: (canonical: string) => registryClient.reveal(canonical) }
      : undefined,
    async anchor(commitment: string, asset = "BTC"): Promise<string> {
      if (registryClient) {
        anchorPayload(commitment); // 格式檢查
        return registryClient.commit(commitment, asset);
      }
      const data = anchorPayload(commitment);
      // 營運帳號的交易要排隊、序號不重複（見 txqueue.ts）
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

/** 從 Concordium 讀回的一筆上鏈交易 */
export type OnChainAnchor = {
  tx: string;
  status: string; // "pending" | "committed" | "finalized"
  block_hash?: string | null;
  block_time?: string | null; // 區塊時間（ISO，UTC）：證明「什麼時候」上鏈
  sender?: string | null;
  transaction_type?: string | null;
  data_hex?: string | null;
  data_text?: string | null;
};

/**
 * 從鏈上讀回一筆上鏈交易：狀態、區塊時間、發送者、資料（hex 與解碼後文字）。
 * 不需要任何私鑰——買方的 agent（MCP verify_signal）直接用它向 Concordium 節點驗證，不必相信賣方的伺服器。
 * 合約模式：只認指定合約（registry）發出的 Committed 事件，轉成同樣的 veriflow:v1:<hash> 格式。
 */
export async function readAnchorTx(
  grpc: ConcordiumGRPCClient,
  txHash: string,
  registry?: ContractAddress.Type,
): Promise<OnChainAnchor> {
  const status = await grpc.getBlockItemStatus(TransactionHash.fromHexString(txHash));
  if (status.status === TransactionStatusEnum.Received) return { tx: txHash, status: "pending" };
  const outcome = status.status === TransactionStatusEnum.Finalized ? status.outcome : status.outcomes[0];
  const s = outcome?.summary as any;
  let dataHex: string | undefined = s?.dataRegistered?.data;
  if (!dataHex && registry && s?.transactionType === "update") {
    for (const e of contractEventsOf(s, registry.index)) {
      const ev = decodeCommittedEvent(e);
      if (ev) dataHex = Buffer.from(ANCHOR_PREFIX + ev.commitment, "utf8").toString("hex");
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
  };
}

/** 交易摘要裡，屬於指定合約的事件（hex） */
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
