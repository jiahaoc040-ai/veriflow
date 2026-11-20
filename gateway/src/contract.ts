/**
 * VeriFlow registry smart contract（Rust，contract/）的部署與使用
 * ---------------------------------------------------------------
 * 合約把 commit–reveal 變成鏈上強制規則：
 *   commit  只有賣方能寫、記錄區塊時間、不能覆蓋
 *   reveal  期滿後任何人都能公開；鏈上自己算 SHA-256，對不上承諾就拒絕
 *
 * 用法（在 gateway/）：
 *   npm run contract -- deploy [horizonDays=7]   部署 CI 編好的模組並建立合約，印出合約編號
 *   npm run contract -- status                    合約總數（REGISTRY_CONTRACT）
 *   npm run contract -- show <commitment>         查一個承諾與它的公開內容
 *   npm run contract -- reveal <commitment>       期滿後從 API 取內容、送上鏈公開
 *
 * 設定 REGISTRY_CONTRACT=<index> 之後，gateway 的每個付費訊號改成用合約 commit 上鏈。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  AccountAddress,
  CcdAmount,
  ContractAddress,
  ContractName,
  Energy,
  EntrypointName,
  ModuleReference,
  Parameter,
  ReceiveName,
  ReturnValue,
  Transaction,
  TransactionExpiry,
  TransactionHash,
} from "@concordium/web-sdk";
import { env, loadAccount } from "./config.js";
import { createGrpc } from "./grpc.js";

export const CONTRACT_NAME = "veriflow_registry";
/** VeriFlow 在 testnet 上的合約 <13094,0>（買方 agent 驗證時，只認這個合約發出的承諾事件） */
export const TESTNET_REGISTRY_INDEX = 13094n;
export const MODULE_URL = "https://github.com/jiahaoc040-ai/veriflow/releases/download/registry-module/module.wasm.v1";
const DAY_MS = 24 * 3600 * 1000;

// ── 參數與回傳值的二進位格式（與 Rust 的 concordium-std Serial 相同）──────────
const u32le = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64le = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const str = (s: string) => { const b = Buffer.from(s, "utf8"); return Buffer.concat([u32le(b.length), b]); };
const hash32 = (hex: string) => {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`not a 64-char hex commitment: ${hex}`);
  return Buffer.from(hex, "hex");
};

export const encodeInit = (horizonMs: bigint) => u64le(horizonMs);
export const encodeCommit = (commitment: string, asset: string) => Buffer.concat([hash32(commitment), str(asset)]);
export const encodeReveal = (canonical: string) => str(canonical);
export const encodeCommitmentKey = (commitment: string) => hash32(commitment);

class Reader {
  private o = 0;
  constructor(private b: Buffer) {}
  u8() { return this.b.readUInt8(this.o++); }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  bytes(n: number) { const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  str() { return this.bytes(this.u32()).toString("utf8"); }
  done() { if (this.o !== this.b.length) throw new Error(`trailing bytes: ${this.b.length - this.o}`); }
}

export type Signal = "RISK_ON" | "RISK_OFF";
export type CommitmentRecord = {
  asset: string;
  committed_at: string;
  reveal: null | { signal: Signal; revealed_at: string; canonical: string };
};
/** SDK 要的是獨立的 ArrayBuffer（不能是共用記憶體的 Buffer 切片） */
const ab = (b: Buffer): ArrayBuffer => new Uint8Array(b).buffer as ArrayBuffer;
const iso = (ms: bigint) => new Date(Number(ms)).toISOString();

export function decodeCommitmentRecord(buf: Buffer): CommitmentRecord | null {
  const r = new Reader(buf);
  if (r.u8() === 0) { r.done(); return null; }
  const asset = r.str();
  const committed_at = iso(r.u64());
  let reveal: CommitmentRecord["reveal"] = null;
  if (r.u8() === 1) {
    const signal: Signal = r.u8() === 0 ? "RISK_ON" : "RISK_OFF";
    reveal = { signal, revealed_at: iso(r.u64()), canonical: r.str() };
  }
  r.done();
  return { asset, committed_at, reveal };
}

export function decodeSummary(buf: Buffer) {
  const r = new Reader(buf);
  const owner = AccountAddress.toBase58(AccountAddress.fromBuffer(ab(r.bytes(32))));
  const out = { owner, horizon_days: Number(r.u64()) / DAY_MS, issued: Number(r.u64()), revealed: Number(r.u64()) };
  r.done();
  return out;
}

/** 合約事件 Committed（tag 0）：tag ‖ commitment(32) ‖ asset ‖ committed_at */
export function decodeCommittedEvent(hex: string): { commitment: string; asset: string } | null {
  const b = Buffer.from(hex, "hex");
  if (b[0] !== 0 || b.length < 37) return null;
  const r = new Reader(b.subarray(1));
  const commitment = r.bytes(32).toString("hex");
  return { commitment, asset: r.str() };
}

// ── 鏈上操作 ────────────────────────────────────────────────────────────────
export function registryAddress(): ContractAddress.Type | undefined {
  const idx = process.env.REGISTRY_CONTRACT;
  return idx ? ContractAddress.create(BigInt(idx), 0n) : undefined;
}

const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

export function createRegistryClient(keyFile: string, contract: ContractAddress.Type) {
  const owner = loadAccount(keyFile);
  const grpc = createGrpc();

  async function send(tx: ReturnType<typeof Transaction.updateContract>) {
    const { nonce } = await grpc.getNextAccountNonce(owner.accountAddress);
    const built = tx.addMetadata({ sender: owner.accountAddress, nonce, expiry: TransactionExpiry.futureMinutes(5) }).build();
    const hash = await grpc.sendTransaction(await Transaction.signAndFinalize(built, owner.signer));
    return TransactionHash.toHexString(hash);
  }

  const update = (entry: string, param: Buffer, energy = 30_000) =>
    send(
      Transaction.updateContract(
        {
          amount: CcdAmount.zero(),
          address: contract,
          receiveName: ReceiveName.create(ContractName.fromString(CONTRACT_NAME), EntrypointName.fromString(entry)),
          message: Parameter.fromBuffer(ab(param)),
        },
        Energy.create(energy),
      ),
    );

  async function view(entry: string, param: Buffer) {
    const res = await grpc.invokeContract({
      contract,
      invoker: owner.accountAddress,
      method: ReceiveName.create(ContractName.fromString(CONTRACT_NAME), EntrypointName.fromString(entry)),
      parameter: Parameter.fromBuffer(ab(param)),
    });
    if (res.tag !== "success" || !res.returnValue) throw new Error(`${entry} failed: ${json(res)}`);
    return Buffer.from(ReturnValue.toHexString(res.returnValue), "hex");
  }

  return {
    address: owner.address,
    /** 付費訊號上鏈：回傳交易 hash（不等最終確認，跟 register data 一樣） */
    commit: (commitment: string, asset: string) => update("commit", encodeCommit(commitment, asset)),
    reveal: (canonical: string) => update("reveal", encodeReveal(canonical), 60_000),
    commitment: async (c: string) => decodeCommitmentRecord(await view("commitment", encodeCommitmentKey(c))),
    summary: async () => decodeSummary(await view("view", Buffer.alloc(0))),
  };
}

async function deploy(horizonDays: number) {
  const owner = loadAccount(env("REGISTRY_OWNER_KEY_FILE", env("FACILITATOR_KEY_FILE")));
  const grpc = createGrpc();
  const source = process.env.CONTRACT_MODULE
    ? readFileSync(process.env.CONTRACT_MODULE)
    : Buffer.from(await (await fetch(MODULE_URL)).arrayBuffer());
  console.log(`module: ${source.length} bytes`);

  const submit = async (tx: any) => {
    const { nonce } = await grpc.getNextAccountNonce(owner.accountAddress);
    const built = tx.addMetadata({ sender: owner.accountAddress, nonce, expiry: TransactionExpiry.futureMinutes(5) }).build();
    const hash = await grpc.sendTransaction(await Transaction.signAndFinalize(built, owner.signer));
    console.log(`  tx https://ccdexplorer.io/testnet/transaction/${TransactionHash.toHexString(hash)}`);
    return (await grpc.waitForTransactionFinalization(hash, 120_000)).summary as any;
  };

  // 模組編號 = 版本化模組檔（.wasm.v1）的 SHA-256；已經在鏈上就不重送
  const moduleRef = ModuleReference.fromHexString(createHash("sha256").update(source).digest("hex"));
  const refHex = ModuleReference.toHexString(moduleRef);
  const onChain = await grpc.getModuleSource(moduleRef).then(() => true, () => false);
  if (onChain) {
    console.log(`1/2 module ${refHex} already on chain`);
  } else {
    console.log("1/2 deploying module…");
    const dep = await submit(Transaction.deployModule({ source: new Uint8Array(source) }));
    if (dep.transactionType === "failed") throw new Error(`deploy failed: ${json(dep.rejectReason ?? dep).slice(0, 600)}`);
    console.log(`  module ${refHex}`);
  }

  console.log(`2/2 creating contract (horizon ${horizonDays} days)…`);
  const init = await submit(
    Transaction.initContract(
      {
        amount: CcdAmount.zero(),
        moduleRef,
        initName: ContractName.fromString(CONTRACT_NAME),
        param: Parameter.fromBuffer(ab(encodeInit(BigInt(Math.round(horizonDays * DAY_MS))))),
      },
      Energy.create(30_000),
    ),
  );
  const inst = init.contractInitialized;
  if (!inst?.address) throw new Error(`init failed: ${json(init.rejectReason ?? init).slice(0, 600)}`);
  console.log(`\n✅ VeriFlow registry contract <${inst.address.index},${inst.address.subindex}>`);
  console.log(`add to gateway/.env:  REGISTRY_CONTRACT=${inst.address.index}`);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "deploy") return deploy(arg ? Number(arg) : 7);

  const address = registryAddress();
  if (!address) throw new Error("set REGISTRY_CONTRACT=<index> in gateway/.env first (printed by `deploy`)");
  const client = createRegistryClient(env("REGISTRY_OWNER_KEY_FILE", env("FACILITATOR_KEY_FILE")), address);

  if (cmd === "status") return console.log(json(await client.summary()));
  if (cmd === "show") return console.log(JSON.stringify(await client.commitment(arg), null, 2));
  if (cmd === "reveal") {
    // 內容從 VeriFlow API 取（期滿後才公開）
    const api = env("API_URL", "http://localhost:8000");
    const c = (await (await fetch(`${api}/commitments/${arg}`)).json()) as { canonical?: string; revealed?: boolean };
    if (!c.canonical) throw new Error("not revealed yet by the API (horizon not reached)");
    const tx = await client.reveal(c.canonical);
    return console.log(`reveal sent: https://ccdexplorer.io/testnet/transaction/${tx}`);
  }
  console.log("usage: npm run contract -- deploy [horizonDays] | status | show <commitment> | reveal <commitment>");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("❌", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
