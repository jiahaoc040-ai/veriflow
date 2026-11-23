/**
 * 網路設定集中在 network.ts：其他檔案不能寫死測試網
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { CONCORDIUM_MAINNET_CAIP2, CONCORDIUM_TESTNET_CAIP2 } from "@x402/concordium";
import { checkGenesis, NETWORKS, selectNetwork } from "../src/network.ts";

test("the bundle is the single source of network values", () => {
  assert.equal(selectNetwork("testnet").caip2, CONCORDIUM_TESTNET_CAIP2);
  assert.equal(selectNetwork("mainnet").caip2, CONCORDIUM_MAINNET_CAIP2);
  assert.equal(selectNetwork("mainnet").did, "Mainnet");
  assert.equal(selectNetwork("testnet").agentRegistry.index, 12802n);
  assert.equal(selectNetwork("mainnet").agentRegistry.index, 10082n);
  assert.throws(() => selectNetwork("devnet"), /testnet or mainnet/);
});

test("a node on the wrong chain is refused", () => {
  const testnetGenesis = "4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796";
  assert.equal(checkGenesis(testnetGenesis, NETWORKS.testnet), testnetGenesis);
  assert.throws(() => checkGenesis(testnetGenesis, NETWORKS.mainnet), /is not mainnet/);
});

test("no network-sensitive literal outside network.ts", () => {
  // score.ts / score-v2.ts are pinned on-chain by hash and name their own deployment; they are not edited
  const skip = new Set(["network.ts", "score.ts", "score-v2.ts"]);
  const bad: string[] = [];
  for (const f of readdirSync(new URL("../src/", import.meta.url))) {
    if (!f.endsWith(".ts") || skip.has(f)) continue;
    const code = readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8")
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)) // comments may mention testnet
      .join("\n");
    for (const pat of [/"Testnet"/, /ccdexplorer\.io\/testnet/, /CONCORDIUM_TESTNET_CAIP2/, /ccd:4221332d/, /12802/, /10082/]) if (pat.test(code)) bad.push(`${f}: ${pat}`);
  }
  assert.deepEqual(bad, []);
});
