/**
 * 網路設定集中在這裡：CONCORDIUM_NETWORK=testnet（預設）或 mainnet
 * ----------------------------------------------------------------
 * 所有跟網路有關的值都從這一組取得：x402 的 CAIP-2、Verify & Access 的 DID 網路、
 * Agent Registry 的網路名稱與合約位址、區塊瀏覽器連結。setAgentWallet 的 genesis 不寫死，
 * 從節點讀，並要求它的前 32 個字元等於 CAIP-2（避免用錯節點或簽到別條鏈）。
 * 測試會確認其他檔案裡沒有寫死 "Testnet"、"ccdexplorer.io/testnet" 或 CAIP-2。
 */
import "./env-file.js"; // .env 先讀，CONCORDIUM_NETWORK 寫在 .env 裡也有效
import { CONCORDIUM_MAINNET_CAIP2, CONCORDIUM_TESTNET_CAIP2 } from "@x402/concordium";

export type NetworkName = "testnet" | "mainnet";

export const NETWORKS = {
  // evm：跨鏈收 USDC 的 EVM 網路（testnet＝Base Sepolia、mainnet＝Base）。agentRegistry：CIS-8004 合約；cis8Registry：CIS-8 外部金鑰登記（把其他鏈的公鑰綁到 Concordium 帳號）。testnet 由官方 badge 檢查回傳；mainnet 見 docs.concordium.com 的 Agent Registry 頁（10082,0）
  testnet: { name: "testnet", did: "Testnet", caip2: CONCORDIUM_TESTNET_CAIP2, explorer: "https://ccdexplorer.io/testnet", agentRegistry: { index: 12802n, subindex: 0n }, cis8Registry: { index: 12801n, subindex: 0n }, evm: { network: "eip155:84532", explorer: "https://sepolia.basescan.org" } },
  mainnet: { name: "mainnet", did: "Mainnet", caip2: CONCORDIUM_MAINNET_CAIP2, explorer: "https://ccdexplorer.io/mainnet", agentRegistry: { index: 10082n, subindex: 0n }, cis8Registry: { index: 10081n, subindex: 0n }, evm: { network: "eip155:8453", explorer: "https://basescan.org" } },
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
