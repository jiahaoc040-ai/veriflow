/**
 * Queue the operator account's transactions
 * --------------------
 * One account (4dNM) sends many kinds of transactions at once: paid-signal anchors, daily signals, reveals, the two eligibility records.
 * Each one first asks the node for the next nonce. Two requests asking at the same time get the same nonce and the chain rejects the later one
 * — with several buyers at once, someone's purchase or verification would fail.
 *
 * Fix:
 *   1. serialize: for one account, fetch nonce → sign → send happens one at a time
 *   2. pickNonce: the node sometimes has not yet counted a just-sent, unconfirmed transaction; remember the nonces we used and take the larger
 */
const tails = new Map<string, Promise<void>>();

export function serialize<T>(account: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(account) ?? Promise.resolve();
  const run = prev.then(fn);
  tails.set(
    account,
    run.then(
      () => undefined,
      () => undefined, // a failure does not affect what is queued behind it
    ),
  );
  return run;
}

const used = new Map<string, bigint>();

/** Take the larger of the node's nonce and our last used nonce + 1, and remember it */
export function pickNonce(account: string, fromNode: bigint): bigint {
  const last = used.get(account);
  const n = last !== undefined && last >= fromNode ? last + 1n : fromNode;
  used.set(account, n);
  return n;
}

/** After a failed send, let the next transaction follow the node again (e.g. this nonce was not actually used) */
export function forgetNonce(account: string) {
  used.delete(account);
}

/**
 * For SDK calls that pick their own nonce (eligibility's createAndAnchor): first wait until the node's nonce has caught up with our last send,
 * otherwise the SDK may get a stale nonce and collide with a transaction not yet in a block. Waits at most timeoutMs.
 */
export async function waitForNode(account: string, nodeNonce: () => Promise<bigint>, timeoutMs = 20_000, pollMs = 1_000) {
  const last = used.get(account);
  if (last === undefined) return;
  const deadline = Date.now() + timeoutMs;
  while ((await nodeNonce()) <= last && Date.now() < deadline) await new Promise((ok) => setTimeout(ok, pollMs));
}
