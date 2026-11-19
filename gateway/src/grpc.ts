/**
 * Concordium gRPC 連線（gateway、上鏈、資格驗證共用設定）
 * ---------------------------------------------------
 * 問題：連線閒置很久後，中間的 NAT／路由器會悄悄把它斷掉，下一次呼叫就卡到 ETIMEDOUT。
 * 解法：
 *   1. keepalive：閒置時每 2 分鐘送一次 ping，連線就不會被當成死線路丟掉
 *   2. 每次呼叫最多等 20 秒，不會無限卡住
 *   3. isTransient()：辨認「網路暫時出錯」，讓呼叫端可以重建連線再試一次
 */
import { ConcordiumGRPCNodeClient, credentials } from "@concordium/web-sdk/nodejs";
import { getConcordiumGrpcUrl, parseGrpcUrl } from "@x402/concordium";
import { NETWORK } from "./config.js";

export const GRPC_CALL_TIMEOUT_MS = 20_000;

export const GRPC_CHANNEL_OPTIONS = {
  "grpc.keepalive_time_ms": 120_000,
  "grpc.keepalive_timeout_ms": 20_000,
  "grpc.keepalive_permit_without_calls": 1,
};

export function grpcEndpoint(): [string, number] {
  return parseGrpcUrl(getConcordiumGrpcUrl(NETWORK));
}

export function createGrpc() {
  const [host, port] = grpcEndpoint();
  return new ConcordiumGRPCNodeClient(host, port, credentials.createSsl(), {
    timeout: GRPC_CALL_TIMEOUT_MS,
    clientOptions: GRPC_CHANNEL_OPTIONS,
  });
}

/** 網路暫時性錯誤（值得重建連線再試一次），不是付款本身有問題 */
export function isTransient(e: unknown): boolean {
  const s = e instanceof Error ? `${e.message} ${(e as { code?: unknown }).code ?? ""}` : String(e);
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|UNAVAILABLE|DEADLINE_EXCEEDED|deadline|socket hang up|Connection dropped|GOAWAY/i.test(s);
}
