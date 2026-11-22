/**
 * 網路設定集中在這裡：CONCORDIUM_NETWORK=testnet（預設）或 mainnet
 * ----------------------------------------------------------------
 * 所有跟網路有關的值都從這一組取得：x402 的 CAIP-2、Verify & Access 的 DID 網路、
 * Agent Registry 的網路名稱、區塊瀏覽器連結。setAgentWallet 的 genesis 不寫死，
 * 從節點讀，並要求它的前 32 個字元等於 CAIP-2（避免用錯節點或簽到別條鏈）。
 * 測試會確認其他檔案裡沒有寫死 "Testnet"、"ccdexplorer.io/testnet" 或 CAIP-2。
 */
import "./env-file.js"; // .env 先讀，CONCORDIUM_NETWORK 寫在 .env 裡也有效
import { CONCORDIUM_MAINNET_CAIP2, CONCORDIUM_TESTNET_CAIP2 } from "@x402/concordium";

export type NetworkName = "testnet" | "mainnet";

export const NETWORKS = {
  testnet: { name: "testnet", did: "Testnet", caip2: CONCORDIUM_TESTNET_CAIP2, explorer: "https://ccdexplorer.io/testnet" },
  mainnet: { name: "mainnet", did: "Mainnet", caip2: CONCORDIUM_MAINNET_CAIP2, explorer: "https://ccdexplorer.io/mainnet" },
} as const;

export function selectNetwork(v = process.env.CONCORDIUM_NETWORK ?? "testnet") {
  if (v !== "testnet" && v !== "mainnet") throw new Error(`CONCORDIUM_NETWORK must be testnet or mainnet, not ${v}`);
  return NETWORKS[v];
}

export const NET = selectNetwork();
export const txLink = (hash: string) => `${NET.explorer}/transaction/${hash}`;

/** 節點的 genesis 必須屬於選定的網路 */
export function checkGenesis(genesisHex: string, net = NET) {
  const want = String(net.caip2).split(":")[1];
  if (!genesisHex.startsWith(want)) throw new Error(`node genesis ${genesisHex.slice(0, 32)}… is not ${net.name} (${net.caip2})`);
  return genesisHex;
}
