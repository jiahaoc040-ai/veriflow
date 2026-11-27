/**
 * One signed payment in flight at a time
 * ----------------------------------------
 * x402's authorization flow verifies, runs the route handler, then settles. A facilitator's verify only checks that the
 * transaction's nonce is the account's next one, so the same signed payment sent N times in parallel passes verify N times
 * and the handler runs N times before the first settles (the ledger then stops all but one delivery, but a handler with side
 * effects has already run). (sender, nonce) is unique on-chain, so it is held here from verify until settlement ends.
 * In-process: run one process per payTo, or use paymentFlow "upfront" for handlers with side effects. Reported by an outside review.
 */
export type InFlight = {
  /** true if this (payer, nonce) was free and is now held */
  take(key: string): boolean;
  release(key: string): void;
};

export function inFlight(ttlMs = 5 * 60_000, now: () => number = Date.now): InFlight {
  const held = new Map<string, number>();
  return {
    take(key) {
      const t = now();
      const at = held.get(key);
      if (at !== undefined && t - at < ttlMs) return false;
      held.set(key, t);
      if (held.size > 10_000) for (const [k, v] of held) if (t - v >= ttlMs) held.delete(k);
      return true;
    },
    release(key) {
      held.delete(key);
    },
  };
}

/** The (sender, nonce) of a Concordium x402 payment, or undefined */
export function paymentKeyOf(payload: unknown): string | undefined {
  const h = (payload as { signedTransaction?: { header?: { sender?: unknown; nonce?: unknown } } } | undefined)?.signedTransaction?.header;
  if (typeof h?.sender !== "string" || (typeof h.nonce !== "string" && typeof h.nonce !== "number" && typeof h.nonce !== "bigint")) return undefined;
  return `${h.sender}:${String(h.nonce)}`;
}
