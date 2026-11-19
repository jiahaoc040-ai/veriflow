/**
 * 連線診斷：比較不同 gRPC 設定能不能連上 Concordium testnet 節點
 * 執行：npm run diag
 */
import { ConcordiumGRPCNodeClient, credentials } from "@concordium/web-sdk/nodejs";
import { GRPC_CHANNEL_OPTIONS, GRPC_CALL_TIMEOUT_MS, grpcEndpoint } from "./grpc.js";

const [host, port] = grpcEndpoint();
const variants: [string, () => ConcordiumGRPCNodeClient][] = [
  ["plain", () => new ConcordiumGRPCNodeClient(host, port, credentials.createSsl())],
  ["timeout only", () => new ConcordiumGRPCNodeClient(host, port, credentials.createSsl(), { timeout: GRPC_CALL_TIMEOUT_MS })],
  ["keepalive + timeout", () => new ConcordiumGRPCNodeClient(host, port, credentials.createSsl(), { timeout: GRPC_CALL_TIMEOUT_MS, clientOptions: GRPC_CHANNEL_OPTIONS })],
];
console.log(`node ${host}:${port}`);
for (const [name, make] of variants) {
  const t = Date.now();
  try {
    const s = await make().getConsensusStatus();
    console.log(`✅ ${name}: ok in ${Date.now() - t} ms (block height ${s.lastFinalizedBlockHeight})`);
  } catch (e) {
    console.log(`❌ ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
