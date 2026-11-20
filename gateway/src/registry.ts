/**
 * Concordium Agent Registry（CIS-8004）註冊工具
 * --------------------------------------------
 * 把 VeriFlow 註冊成鏈上的 Agent（一顆 CIS-8004 NFT），並把 Agent Card 的 SHA-256 釘在鏈上，
 * 取得「Verified by Concordium」badge：任何人都能從鏈上確認這個 Agent 的擁有者帳號（背後是通過身份驗證的真人）、
 * 狀態是 Active，而且公開的 Agent Card 沒被換過。
 *
 * 交易參數由官方 Agent Registry MCP 服務（agent-registry-mcp.concordium.com）產生；
 * 簽名與送出在本機用擁有者帳號的金鑰完成（MCP 服務不碰任何金鑰）。
 *
 * 用法：
 *   npm run registry -- register            鑄造 Agent NFT，印出 token id
 *   npm run registry -- set-uri <tokenId>   讀取公開的 Agent Card、算 SHA-256、釘上鏈
 *   npm run registry -- status <tokenId>    官方 badge 檢查
 *
 * 擁有者帳號：REGISTRY_OWNER_KEY_FILE（預設 = FACILITATOR_KEY_FILE）
 * Agent Card 網址：AGENT_CARD_URL（預設 GitHub 上的 agent-card.json）
 */
import { createHash } from "node:crypto";
import {
  AccountAddress,
  CcdAmount,
  ContractAddress,
  Energy,
  Parameter,
  ReceiveName,
  Transaction,
  TransactionExpiry,
  TransactionHash,
} from "@concordium/web-sdk";
import { env, loadAccount } from "./config.js";
import { createGrpc } from "./grpc.js";

export const REGISTRY_MCP = env("REGISTRY_MCP_URL", "https://agent-registry-mcp.concordium.com/mcp");
export const REGISTRY_NETWORK = "testnet";
export const DEFAULT_CARD_URL = "https://raw.githubusercontent.com/jiahaoc040-ai/veriflow/main/agent-card.json";
/** VeriFlow 在 testnet Agent Registry <12802,0> 的 token id（2026-11-20 註冊） */
export const VERIFLOW_TOKEN_ID = "1313";

/** 呼叫官方 Agent Registry MCP 服務的一個工具（JSON-RPC over HTTP） */
export async function registryTool(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(REGISTRY_MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  // 伺服器可能回 JSON，也可能回 SSE（data: {...}）
  const jsonText = text.trim().startsWith("{") ? text : (text.match(/^data: (.*)$/m)?.[1] ?? text);
  const msg = JSON.parse(jsonText);
  if (msg.error) throw new Error(`${name}: ${JSON.stringify(msg.error)}`);
  const out = (msg.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n");
  if (msg.result?.isError) throw new Error(`${name}: ${out}`);
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

/**
 * 從合約事件裡找新 Agent 的 token id：CIS-8004 Registered（tag 0xF0）或 CIS-2 Mint（tag 0xFE）。
 * 格式：tag ‖ token_id 長度(1 byte) ‖ token_id ‖ …；CIS-8004 的 token id 是 8 bytes little-endian 的 u64。
 */
export function mintedTokenId(eventHexes: string[]): string | undefined {
  for (const hex of eventHexes) {
    const b = Buffer.from(hex, "hex");
    if (b[0] !== 0xf0 && b[0] !== 0xfe) continue;
    const len = b[1];
    const id = b.subarray(2, 2 + len);
    if (id.length !== len || len === 0 || len > 8) continue;
    let v = 0n;
    for (let i = id.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(id[i]);
    return v.toString();
  }
  return undefined;
}

/** 從最終確認的交易摘要裡收集所有合約事件（hex） */
function contractEvents(summary: any): string[] {
  const out: string[] = [];
  const walk = (x: any) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x.events))
      for (const e of x.events) {
        if (typeof e === "string") out.push(e);
        // web-sdk v12：合約事件是 ContractEvent 物件（bytes 在 .buffer）
        else if (e?.buffer instanceof Uint8Array) out.push(Buffer.from(e.buffer).toString("hex"));
      }
    for (const v of Object.values(x)) if (v && typeof v === "object") walk(v);
  };
  walk(summary);
  return out;
}

async function submit(owner: ReturnType<typeof loadAccount>, built: any) {
  const grpc = createGrpc();
  const { nonce } = await grpc.getNextAccountNonce(owner.accountAddress);
  const tx = Transaction.updateContract(
    {
      amount: CcdAmount.zero(),
      address: ContractAddress.create(built.contract_address.index, built.contract_address.subindex),
      receiveName: ReceiveName.fromString(built.receive_name),
      message: Parameter.fromHexString(built.parameter_hex),
    },
    Energy.create(built.suggested_energy ?? 30000),
  )
    .addMetadata({ sender: owner.accountAddress, nonce, expiry: TransactionExpiry.futureMinutes(5) })
    .build();
  const signed = await Transaction.signAndFinalize(tx, owner.signer);
  const hash = await grpc.sendTransaction(signed);
  const txHex = TransactionHash.toHexString(hash);
  console.log(`submitted ${built.receive_name}: https://ccdexplorer.io/testnet/transaction/${txHex}`);
  const outcome = await grpc.waitForTransactionFinalization(hash, 120_000);
  const s: any = outcome.summary;
  if (s.type !== "accountTransaction" || s.transactionType === "failed")
    throw new Error(`transaction failed: ${JSON.stringify(s.rejectReason ?? s, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  return { txHex, summary: s };
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const owner = loadAccount(env("REGISTRY_OWNER_KEY_FILE", env("FACILITATOR_KEY_FILE")));
  const ownerB58 = AccountAddress.toBase58(owner.accountAddress);
  const cardUrl = env("AGENT_CARD_URL", DEFAULT_CARD_URL);

  if (cmd === "register") {
    const built = await registryTool("build_register", { network: REGISTRY_NETWORK, sender: ownerB58 });
    const { summary } = await submit(owner, built);
    let tokenId = mintedTokenId(contractEvents(summary));
    if (!tokenId) {
      const owned = await registryTool("agents_by_owner", { network: REGISTRY_NETWORK, owner_account: ownerB58 });
      console.log("could not read token id from events; agents owned by this account:", JSON.stringify(owned).slice(0, 800));
      return;
    }
    console.log(`\n✅ registered VeriFlow agent: token id ${tokenId} (owner ${ownerB58})`);
    console.log(`next: tell Claude the token id; then run  npm run registry -- set-uri ${tokenId}`);
    return;
  }

  if (cmd === "set-uri") {
    if (!arg) throw new Error("usage: npm run registry -- set-uri <tokenId>");
    // 雜湊必須是「驗證者實際會下載到的位元組」，所以直接抓公開網址，而不是讀本機檔案
    const res = await fetch(cardUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`cannot fetch ${cardUrl}: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const sha = createHash("sha256").update(bytes).digest("hex");
    console.log(`card ${cardUrl}  sha256=${sha}`);
    const built = await registryTool("build_set_agent_uri", {
      network: REGISTRY_NETWORK,
      token_id: arg,
      agent_uri: cardUrl,
      metadata_hash_hex: sha,
      sender: ownerB58,
    });
    await submit(owner, built);
    console.log("\nAgent Card pinned on-chain. Badge check:");
  }

  if (cmd === "set-uri" || cmd === "status") {
    if (!arg) throw new Error("usage: npm run registry -- status <tokenId>");
    const info = await registryTool("contract_info", { network: REGISTRY_NETWORK });
    const t = await registryTool("token_address", {
      contract_index: info.cis8004_contract.index,
      contract_subindex: info.cis8004_contract.subindex,
      token_id: arg,
    });
    console.log(`badge: ${t.token_address}`);
    const check = await registryTool("check_badge", { id: t.token_address, network: REGISTRY_NETWORK });
    console.log(JSON.stringify(check, null, 2));
    return;
  }

  console.log("usage: npm run registry -- register | set-uri <tokenId> | status <tokenId>");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("❌", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
