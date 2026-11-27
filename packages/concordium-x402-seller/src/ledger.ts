/**
 * Deliver each payment once
 * -------------------------
 * The same signed payment can arrive in many requests at once. Settlement makes only one of them succeed on-chain, but a
 * "failed" settlement whose transaction did go through could be recovered from the chain for each of the others. The ledger
 * records every settlement transaction that was delivered against; a second claim of the same hash is refused.
 * In memory by default; pass your own (e.g. one SQL statement with a unique key) when you run more than one process.
 */
export type PaymentLedger = {
  /** Record a delivered settlement; false = this transaction was already delivered against */
  claim(tx: string): Promise<boolean>;
};

/**
 * In memory: nothing is ever forgotten while the process runs (a forgotten hash could be delivered again), and nothing survives
 * a restart. One entry per paid settlement. For anything beyond a demo, use sqlLedger, shared by every process that sells to the same payTo.
 */
export function memoryLedger(): PaymentLedger {
  const seen = new Set<string>();
  return {
    async claim(tx) {
      const k = tx.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    },
  };
}

/**
 * A ledger on any SQL database you already have: `run` executes the statement and returns how many rows it inserted.
 * Postgres: CREATE TABLE delivered_payments (tx TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now())
 */
export function sqlLedger(run: (sql: string, params: unknown[]) => Promise<number>): PaymentLedger {
  return {
    async claim(tx) {
      return (await run("INSERT INTO delivered_payments (tx) VALUES ($1) ON CONFLICT DO NOTHING", [tx.toLowerCase()])) === 1;
    },
  };
}
