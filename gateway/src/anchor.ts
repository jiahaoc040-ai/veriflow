/**
 * 把訊號的承諾雜湊寫上 Concordium（register data 交易，不需要智能合約）
 * -------------------------------------------------------------------
 * 鏈上資料格式（UTF-8 文字，ccdexplorer 上可以直接看到）：
 *   veriflow:v1:<64 字元 SHA-256 承諾雜湊>
 *
 * 只送出、不等最終確認（約 10 秒），避免拖慢買方拿訊號；交易 hash 會立刻回傳。
 */
import { ConcordiumGRPCNodeClient, credentials } from "@concordium/web-sdk/nodejs";
import {
  AccountAddress,
  BlockHash,
  DataBlob,
  TransactionExpiry,
  TransactionHash,
  TransactionStatusEnum,
} from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";
import { getConcordiumGrpcUrl, parseGrpcUrl } from "@x402/concordium";
import { NETWORK, loadAccount } from "./config.js";

import { ANCHOR_PREFIX } from "./anchor-format.js";
export { ANCHOR_PREFIX };

export function anchorPayload(commitment: string): ArrayBuffer {
  if (!/^[0-9a-f]{64}$/.test(commitment)) throw new Error(`commitment 格式錯誤：${commitment}`);
  return new TextEncoder().encode(ANCHOR_PREFIX + commitment).buffer as ArrayBuffer;
}

export function createAnchorer(keyFile: string) {
  const account = loadAccount(keyFile);
  const [host, port] = parseGrpcUrl(getConcordiumGrpcUrl(NETWORK));
  const grpc = new ConcordiumGRPCNodeClient(host, port, credentials.createSsl());

  return {
    address: account.address,

    /** 從鏈上讀回一筆 register data 交易：狀態、發送者、資料（hex 與解碼後文字） */
    async read(txHash: string) {
      const status = await grpc.getBlockItemStatus(TransactionHash.fromHexString(txHash));
      if (status.status === TransactionStatusEnum.Received) return { tx: txHash, status: "pending" };
      const outcome = status.status === TransactionStatusEnum.Finalized ? status.outcome : status.outcomes[0];
      const s = outcome?.summary as any;
      const dataHex: string | undefined = s?.dataRegistered?.data;
      return {
        tx: txHash,
        status: status.status, // "finalized" | "committed"
        block_hash: outcome ? BlockHash.toHexString(outcome.blockHash) : null,
        sender: s?.sender ? AccountAddress.toBase58(s.sender) : null,
        transaction_type: s?.transactionType ?? null,
        data_hex: dataHex ?? null,
        data_text: dataHex ? Buffer.from(dataHex, "hex").toString("utf8") : null,
      };
    },
    async anchor(commitment: string): Promise<string> {
      const data = anchorPayload(commitment);
      const { nonce } = await grpc.getNextAccountNonce(account.accountAddress);
      const tx = Transaction.registerData({ data: new DataBlob(data) })
        .addMetadata({
          sender: account.accountAddress,
          nonce,
          expiry: TransactionExpiry.futureMinutes(5),
        })
        .build();
      const finalized = await Transaction.signAndFinalize(tx, account.signer);
      const hash = await grpc.sendTransaction(finalized);
      return TransactionHash.toHexString(hash);
    },
  };
}
