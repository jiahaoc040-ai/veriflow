/**
 * Concordium gRPC connection (shared settings for the gateway, anchoring and eligibility)
 * ---------------------------------------------------
 * Problem: after a long idle period, a NAT or router in between silently drops the connection and the next call hangs until ETIMEDOUT.
 * Fix:
 *   1. keepalive: ping every 2 minutes while idle, so the connection is not treated as dead
 *   2. every call waits at most 20 seconds, never forever
 *   3. isTransient(): recognizes temporary network errors so the caller can reconnect and retry once
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

/** A temporary network error (worth reconnecting and retrying), not a problem with the payment itself */
export function isTransient(e: unknown): boolean {
  const s = e instanceof Error ? `${e.message} ${(e as { code?: unknown }).code ?? ""}` : String(e);
  return /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|EAI_AGAIN|UNAVAILABLE|DEADLINE_EXCEEDED|deadline|socket hang up|Connection dropped|GOAWAY/i.test(s);
}
