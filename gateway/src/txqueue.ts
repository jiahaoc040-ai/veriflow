/**
 * 營運帳號送交易要排隊
 * --------------------
 * 同一個帳號（4dNM）會同時送很多種交易：付費訊號上鏈、每日訊號、到期公開、資格驗證的兩筆紀錄。
 * 每一筆都要先問節點「下一個序號（nonce）」。兩個請求同時問，會拿到同一個序號，後送的那筆就被鏈拒絕
 * ——在多人同時購買時，某個買家就會買不到或驗證失敗。
 *
 * 解法：
 *   1. serialize：同一個帳號的「取序號 → 簽名 → 送出」一次只做一件
 *   2. pickNonce：節點有時還沒算進剛送出、尚未打包的交易；記住自己用過的序號，取兩者較大的
 */
const tails = new Map<string, Promise<void>>();

export function serialize<T>(account: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(account) ?? Promise.resolve();
  const run = prev.then(fn);
  tails.set(
    account,
    run.then(
      () => undefined,
      () => undefined, // 前一筆失敗不影響後面排隊的
    ),
  );
  return run;
}

const used = new Map<string, bigint>();

/** 從節點拿到的序號，與自己上次用過的序號 +1 取較大值，並記下來 */
export function pickNonce(account: string, fromNode: bigint): bigint {
  const last = used.get(account);
  const n = last !== undefined && last >= fromNode ? last + 1n : fromNode;
  used.set(account, n);
  return n;
}

/** 送出失敗時，讓下一筆重新以節點為準（例如這個序號其實沒被用掉） */
export function forgetNonce(account: string) {
  used.delete(account);
}

/**
 * 給「自己取序號」的 SDK 呼叫用（資格驗證的 createAndAnchor）：先等節點的序號追上我們最後送出的那筆，
 * 否則 SDK 可能拿到舊序號、跟剛送出還沒打包的交易撞號。最多等 timeoutMs。
 */
export async function waitForNode(account: string, nodeNonce: () => Promise<bigint>, timeoutMs = 20_000, pollMs = 1_000) {
  const last = used.get(account);
  if (last === undefined) return;
  const deadline = Date.now() + timeoutMs;
  while ((await nodeNonce()) <= last && Date.now() < deadline) await new Promise((ok) => setTimeout(ok, pollMs));
}
