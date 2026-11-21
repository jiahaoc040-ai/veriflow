/**
 * 營運帳號交易排隊：模擬多人同時購買，確認序號不重複、一次只送一筆、失敗不卡住後面
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { forgetNonce, pickNonce, serialize, waitForNode } from "../src/txqueue.ts";

/** 假節點：回報的下一個序號可能落後（還沒算進剛送出的交易） */
function fakeNode(lag = true) {
  let accepted = 10n; // 下一個可用序號
  const seen = new Set<bigint>();
  let inFlight = 0;
  let maxInFlight = 0;
  return {
    get maxInFlight() {
      return maxInFlight;
    },
    nextNonce: async () => (lag ? accepted - (accepted > 10n ? 1n : 0n) : accepted), // 落後一筆
    async send(nonce: bigint) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((ok) => setTimeout(ok, 5));
      inFlight--;
      if (seen.has(nonce)) throw new Error(`duplicate nonce ${nonce}`);
      seen.add(nonce);
      accepted = nonce + 1n;
      return `tx-${nonce}`;
    },
  };
}

test("10 buyers at once: one send at a time, every nonce distinct even when the node lags", async () => {
  const node = fakeNode(true);
  const acct = "op-1";
  const sendOne = () => serialize(acct, async () => node.send(pickNonce(acct, await node.nextNonce())));
  const txs = await Promise.all(Array.from({ length: 10 }, sendOne));
  assert.equal(new Set(txs).size, 10);
  assert.deepEqual(txs, Array.from({ length: 10 }, (_, i) => `tx-${10 + i}`));
  assert.equal(node.maxInFlight, 1);
});

test("without the queue the same burst collides (the bug this fixes)", async () => {
  const node = fakeNode(false);
  const results = await Promise.allSettled(Array.from({ length: 5 }, async () => node.send(await node.nextNonce())));
  assert.ok(results.some((r) => r.status === "rejected"));
});

test("a failed send does not block the queue, and the next send trusts the node again", async () => {
  const acct = "op-2";
  const order: string[] = [];
  const a = serialize(acct, async () => {
    order.push("a");
    throw new Error("node down");
  });
  const b = serialize(acct, async () => {
    order.push("b");
    return "ok";
  });
  await assert.rejects(a, /node down/);
  assert.equal(await b, "ok");
  assert.deepEqual(order, ["a", "b"]);
  assert.equal(pickNonce(acct, 5n), 5n);
  assert.equal(pickNonce(acct, 5n), 6n); // 節點還回報 5：用 6
  forgetNonce(acct);
  assert.equal(pickNonce(acct, 5n), 5n); // 忘記之後以節點為準
});

test("waitForNode: waits until the node has caught up with our last send, with a timeout", async () => {
  const acct = "op-3";
  await waitForNode(acct, async () => 0n); // 沒送過：不用等
  pickNonce(acct, 7n);
  let n = 7n;
  const t0 = Date.now();
  await waitForNode(acct, async () => n++, 1_000, 10); // 第二次問就追上（8 > 7）
  assert.ok(Date.now() - t0 < 500);
  const t1 = Date.now();
  await waitForNode(acct, async () => 7n, 50, 10); // 一直沒追上：逾時放行
  assert.ok(Date.now() - t1 >= 50);
});
