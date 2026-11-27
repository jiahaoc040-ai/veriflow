/**
 * One account, many transactions: anchors for different buyers can be sent at the same moment, and each SDK call asks the node
 * for the next nonce. Two at once get the same nonce and the chain rejects one. So the transactions of one account are sent one
 * at a time, each after the node has counted the previous one.
 */
const tails = new Map<string, Promise<void>>();

export function serialize<T>(account: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(account) ?? Promise.resolve();
  const run = prev.then(fn);
  tails.set(account, run.then(() => undefined, () => undefined));
  return run;
}

/** Wait until the node's next nonce for this account is past `last` (or `timeoutMs` passes) */
export async function waitForNonce(nodeNonce: () => Promise<bigint>, last: bigint | undefined, timeoutMs = 20_000, pollMs = 1_000) {
  if (last === undefined) return;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await nodeNonce()) > last) return;
    // Sending now would reuse the previous transaction's nonce, and one of the two would be rejected
    if (Date.now() >= deadline) throw new Error("the node has not yet counted the previous anchor; please try again shortly");
    await new Promise((ok) => setTimeout(ok, pollMs));
  }
}
