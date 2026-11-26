/**
 * Concordium Agent Registry (CIS-8004) tool
 * --------------------------------------------
 * Registers VeriFlow as an on-chain agent (a CIS-8004 NFT) and pins the Agent Card's SHA-256 on-chain,
 * which earns the "Verified by Concordium" badge: anyone can confirm from the chain the agent's owner account (an identity-verified person),
 * that it is Active, and that the public Agent Card has not been swapped.
 *
 * Transaction parameters come from the official Agent Registry MCP service (agent-registry-mcp.concordium.com);
 * signing and submitting happen locally with the owner account's key (the MCP service never touches a key).
 *
 * Usage:
 *   npm run registry -- register            mint the agent NFT and print the token id
 *   npm run registry -- set-uri <tokenId>   fetch the public Agent Card, compute its SHA-256, pin it on-chain
 *   npm run registry -- status <tokenId>    official badge check
 *   npm run registry -- set-wallet <tokenId>
 *        registers the payout account (SELLER_KEY_FILE, = x402 payTo) as the agent's on-chain agentWallet.
 *        The payout account signs an authorization message (checked byte by byte before signing); the owner account submits the transaction.
 *        Buyer agents (ours or anyone's) compare payTo with agentWallet before paying, which stops impostors.
 *
 * Owner account: REGISTRY_OWNER_KEY_FILE (default = FACILITATOR_KEY_FILE)
 * Agent Card URL: AGENT_CARD_URL (default: agent-card.json on GitHub)
 */
import { NET, checkGenesis, txLink } from "./network.js";
import { BlockHash } from "@concordium/web-sdk";
import { createHash } from "node:crypto";
import { readCapped } from "./counterparty.js";
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
export const REGISTRY_NETWORK = NET.name;
export const DEFAULT_CARD_URL = "https://raw.githubusercontent.com/jiahaoc040-ai/veriflow/main/agent-card.json";
/** VeriFlow's token id in the testnet Agent Registry <12802,0> (registered 2026-11-20) */
export const VERIFLOW_TOKEN_ID = "1313";

/** Call one tool of the official Agent Registry MCP service (JSON-RPC over HTTP) */
export async function registryTool(name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(REGISTRY_MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(20_000),
    redirect: "error",
  });
  // 429/5xx are retryable as such (retrying() matches "HTTP 5xx"); a body is read up to 256 KB
  if (res.status === 429 || res.status >= 500) throw new Error(`${name}: HTTP ${res.status}`);
  if (!res.ok) throw new Error(`${name}: registry answered HTTP ${res.status}`);
  const text = (await readCapped(res, 256 * 1024)).toString("utf8");
  // The server may answer with JSON or with SSE (data: {...})
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
 * Find the new agent's token id in the contract events: CIS-8004 Registered (tag 0xF0) or CIS-2 Mint (tag 0xFE).
 * Layout: tag ‖ token_id length (1 byte) ‖ token_id ‖ …; a CIS-8004 token id is a u64, 8 bytes little-endian.
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

/** Testnet genesis hash (the setAgentWallet authorization is bound to the chain, preventing cross-chain replay) */
export const TESTNET_GENESIS = "4221332d34e1694168c2a0c0b3fd0f273809612cb13d000d5c2e00e85f50f796";
const SET_WALLET_PREFIX = "CIS-8004/v1/setAgentWallet";

/**
 * Parse and check the 162-byte setAgentWallet authorization message — before signing, confirm it authorizes exactly what we mean;
 * never blind-sign bytes from a remote service. Layout (official set_agent_wallet_canonical_bytes):
 *   prefix(26) ‖ token_id u64 LE(8) ‖ owner(32) ‖ new_wallet(32) ‖ nonce u64 LE(8) ‖ deadline u64 LE(8) ‖ contract index,subindex u64 LE(16) ‖ genesis(32)
 */
export function checkSetWalletMessage(
  bytes: Uint8Array,
  want: { tokenId: string; owner: string; wallet: string; deadlineMs: number; contract: { index: bigint; subindex: bigint }; genesis: string },
): { nonce: bigint } {
  const b = Buffer.from(bytes);
  if (b.length !== 162) throw new Error(`authorization message is ${b.length} bytes, expected 162`);
  const fail = (what: string) => {
    throw new Error(`authorization message ${what} does not match; refusing to sign`);
  };
  if (b.subarray(0, 26).toString("utf8") !== SET_WALLET_PREFIX) fail("prefix");
  if (b.readBigUInt64LE(26) !== BigInt(want.tokenId)) fail("token id");
  if (!b.subarray(34, 66).equals(Buffer.from(AccountAddress.fromBase58(want.owner).decodedAddress))) fail("owner");
  if (!b.subarray(66, 98).equals(Buffer.from(AccountAddress.fromBase58(want.wallet).decodedAddress))) fail("new wallet");
  const nonce = b.readBigUInt64LE(98);
  if (b.readBigUInt64LE(106) !== BigInt(want.deadlineMs)) fail("deadline");
  if (b.readBigUInt64LE(114) !== want.contract.index || b.readBigUInt64LE(122) !== want.contract.subindex) fail("contract");
  if (b.subarray(130, 162).toString("hex") !== want.genesis) fail("chain (genesis hash)");
  return { nonce };
}

/** Collect all contract events (hex) from a finalized transaction summary */
function contractEvents(summary: any): string[] {
  const out: string[] = [];
  const walk = (x: any) => {
    if (!x || typeof x !== "object") return;
    if (Array.isArray(x.events))
      for (const e of x.events) {
        if (typeof e === "string") out.push(e);
        // web-sdk v12: contract events are ContractEvent objects (bytes in .buffer)
        else if (e?.buffer instanceof Uint8Array) out.push(Buffer.from(e.buffer).toString("hex"));
      }
    for (const v of Object.values(x)) if (v && typeof v === "object") walk(v);
  };
  walk(summary);
  return out;
}

export async function submit(owner: ReturnType<typeof loadAccount>, built: any) {
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
  console.log(`submitted ${built.receive_name}: ${txLink(txHex)}`);
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
    // The hash must be of the bytes verifiers actually download, so fetch the public URL rather than read the local file
    const res = await fetch(cardUrl, { cache: "no-store" });
    if (!res.ok) throw new Error(`cannot fetch ${cardUrl}: HTTP ${res.status}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const sha = createHash("sha256").update(bytes).digest("hex");
    console.log(`card ${cardUrl}  sha256=${sha}`);
    // Safety check: the card's own declared agent id must be the one being pinned (in case .env's AGENT_CARD_URL still points at another agent's card)
    try {
      const ids = ((JSON.parse(bytes.toString("utf8")) as { registrations?: { agentId?: unknown }[] }).registrations ?? []).map((r) => String(r.agentId));
      if (ids.length && !ids.includes(arg)) throw new Error(`this card declares agent ${ids.join(", ")}, not ${arg}; set AGENT_CARD_URL to agent ${arg}'s card`);
    } catch (e) {
      if (e instanceof SyntaxError) throw new Error(`${cardUrl} is not JSON`);
      throw e;
    }
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

  if (cmd === "set-wallet") {
    if (!arg) throw new Error("usage: npm run registry -- set-wallet <tokenId>");
    const wallet = loadAccount(env("SELLER_KEY_FILE", "keys/seller.export"));
    const seller = process.env.SELLER_ADDRESS;
    if (seller && seller !== wallet.address)
      throw new Error(`SELLER_KEY_FILE is ${wallet.address}, but the x402 payTo SELLER_ADDRESS is ${seller}; the payout address is the one to register`);
    const deadlineMs = Date.now() + 15 * 60_000;
    const msg = await registryTool("set_agent_wallet_canonical_bytes", {
      network: REGISTRY_NETWORK,
      token_id: arg,
      new_wallet: wallet.address,
      deadline_unix_ms: deadlineMs,
    });
    const bytes = Buffer.from(String(msg.bytes_hex), "hex");
    const { nonce } = checkSetWalletMessage(bytes, {
      tokenId: arg,
      owner: ownerB58,
      wallet: wallet.address,
      deadlineMs,
      contract: { index: BigInt(msg.contract_address?.index ?? NET.agentRegistry.index), subindex: BigInt(msg.contract_address?.subindex ?? NET.agentRegistry.subindex) },
      genesis: checkGenesis(BlockHash.toHexString((await createGrpc().getConsensusStatus()).genesisBlock)),
    });
    console.log(`authorization message checked (agent #${arg}, owner ${ownerB58}, new wallet ${wallet.address}, nonce ${nonce})`);
    const sigs = await wallet.signer.sign(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) as ArrayBuffer);
    const signatureHex = Object.values(Object.values(sigs)[0] ?? {})[0];
    if (!signatureHex) throw new Error("the payout account has no usable signing key");
    const built = await registryTool("build_set_agent_wallet", {
      network: REGISTRY_NETWORK,
      token_id: arg,
      new_wallet: wallet.address,
      deadline_unix_ms: deadlineMs,
      signature_hex: signatureHex,
      sender: ownerB58,
    });
    await submit(owner, built);
    const now = await registryTool("get_agent_wallet", { network: REGISTRY_NETWORK, token_id: arg });
    console.log(`\n✅ agent #${arg}'s on-chain agentWallet: ${JSON.stringify(now)}`);
    return;
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

  console.log("usage: npm run registry -- register | set-uri <tokenId> | set-wallet <tokenId> | status <tokenId>");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("❌", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
