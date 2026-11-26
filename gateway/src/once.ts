/**
 * Small guards against doing paid work twice
 * ------------------------------------------
 * singleFlight: concurrent callers with the same key share one run (e.g. one on-chain anchor per commitment, however many
 *   requests carrying the same signed payment arrive at once).
 * PaymentLedger: a settlement transaction is delivered against once. A settlement reported as failed is recovered from the
 *   chain only if that transaction hash was never delivered before; a success whose hash was already used is failed closed.
 */
export function singleFlight<T>() {
  const running = new Map<string, Promise<T>>();
  return (key: string, f: () => Promise<T>): Promise<T> => {
    const hit = running.get(key);
    if (hit) return hit;
    const p = f().finally(() => running.delete(key));
    running.set(key, p);
    return p;
  };
}

export type PaymentLedger = {
  /** Record a delivered settlement; false = this transaction was already delivered against */
  claim(tx: string): Promise<boolean>;
};

export function memoryLedger(max = 100_000): PaymentLedger {
  const seen = new Set<string>();
  return {
    async claim(tx) {
      const k = tx.toLowerCase();
      if (seen.has(k)) return false;
      // Oldest first out: a settlement tx hash is never reused, so forgetting a very old one is harmless
      if (seen.size >= max) seen.delete(seen.values().next().value!);
      seen.add(k);
      return true;
    },
  };
}

export function postgresLedger(url: string): PaymentLedger {
  let pool: import("pg").Pool | undefined;
  const db = async () => {
    if (!pool) {
      const { default: pg } = await import("pg");
      pool = new pg.Pool({ connectionString: url, max: 2, ssl: pgSsl(url) });
      await pool.query("CREATE TABLE IF NOT EXISTS delivered_payments (tx TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now())");
    }
    return pool;
  };
  return {
    async claim(tx) {
      const { rowCount } = await (await db()).query("INSERT INTO delivered_payments (tx) VALUES ($1) ON CONFLICT DO NOTHING", [tx.toLowerCase()]);
      return rowCount === 1;
    },
  };
}

/** TLS to Postgres unless the URL says sslmode=disable (local development) */
export function pgSsl(url: string): { rejectUnauthorized: true } | undefined {
  return /sslmode=disable/.test(url) || /@(localhost|127\.0\.0\.1)[:/]/.test(url) ? undefined : { rejectUnauthorized: true };
}
