/**
 * VeriFlow 合約 v2（contract-v2/）的鏈下工具
 * ------------------------------------------
 * 合約規則：每個 (資產, as_of) 只能一筆、只在 as_of 收盤後一天內能 commit、BTC/ETH 與 7 天寫死、
 * 冷擁有者指定一個上鏈帳號（不能是自己）、公開時合約檢查格式、鍵與規則。
 *
 * 用法（在 gateway/，擁有者金鑰 REGISTRY_OWNER_KEY_FILE＝4dNM，只在你自己的電腦上跑）：
 *   npm run contract2 -- deploy                 部署 CI 編好的 v2 模組並建立合約，印出合約編號、模組編號、init 交易
 *   npm run contract2 -- set-committer <帳號>    指定上鏈帳號（會取代舊的）
 *   npm run contract2 -- revoke-committer       撤銷上鏈帳號（出事時用）
 *   npm run contract2 -- status                 合約摘要（REGISTRY_V2_CONTRACT）
 *   npm run contract2 -- slot <BTC|ETH> <YYYY-MM-DD>
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
  SequenceNumber,
  Transaction,
  TransactionExpiry,
  TransactionHash,
} from "@concordium/web-sdk";
import { env, loadAccount } from "./config.js";
import { createGrpc } from "./grpc.js";
import { forgetNonce, pickNonce, serialize } from "./txqueue.js";

export const CONTRACT_V2_NAME = "veriflow_registry_v2";
export const MODULE_V2_URL = "https://github.com/jiahaoc040-ai/veriflow/releases/download/registry-module-v2/module.wasm.v1";
export const DAY_MS = 86_400_000;
export const HORIZON_MS = 7 * DAY_MS;

// ── 編碼 ──
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const str = (s: string) => { const b = Buffer.from(s, "utf8"); return Buffer.concat([u32(b.length), b]); };
const hash32 = (hex: string) => {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`bad hash ${hex}`);
  return Buffer.from(hex, "hex");
};
export const encodeCommitV2 = (asset: string, asOf: string, commitment: string) => Buffer.concat([str(asset), str(asOf), hash32(commitment)]);
export const encodeSlotV2 = (asset: string, asOf: string) => Buffer.concat([str(asset), str(asOf)]);
export const encodeRevealV2 = (canonical: string) => str(canonical);
export const encodeAccount = (addr: string) => Buffer.from(AccountAddress.fromBase58(addr).decodedAddress);

// ── 解碼 ──
class Reader {
  o = 0;
  constructor(private b: Buffer) {}
  u8() { return this.b.readUInt8(this.o++); }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  bytes(n: number) { const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  str() { return this.bytes(this.u32()).toString("utf8"); }
  account() { return AccountAddress.toBase58(AccountAddress.fromBuffer(new Uint8Array(this.bytes(32)).buffer as ArrayBuffer)); }
  done() { if (this.o !== this.b.length) throw new Error(`trailing bytes: ${this.b.length - this.o}`); }
}
const iso = (ms: bigint) => new Date(Number(ms)).toISOString();

export type SlotV2 = {
  commitment: string;
  committed_at: string;
  reveal: null | { signal: "RISK_ON" | "RISK_OFF"; revealed_at: string; canonical: string };
};
export function decodeSlotV2(buf: Buffer): SlotV2 | null {
  const r = new Reader(buf);
  if (r.u8() === 0) { r.done(); return null; }
  const commitment = r.bytes(32).toString("hex");
  const committed_at = iso(r.u64());
  let reveal: SlotV2["reveal"] = null;
  if (r.u8() === 1) {
    const signal = r.u8() === 0 ? "RISK_ON" : "RISK_OFF";
    reveal = { signal, revealed_at: iso(r.u64()), canonical: r.str() };
  }
  r.done();
  return { commitment, committed_at, reveal };
}
export type SummaryV2 = { owner: string; committer: string | null; horizon_ms: number; init_time: string; issued: number; revealed: number };
export function decodeSummaryV2(buf: Buffer): SummaryV2 {
  const r = new Reader(buf);
  const owner = r.account();
  const committer = r.u8() === 1 ? r.account() : null;
  const out = { owner, committer, horizon_ms: Number(r.u64()), init_time: iso(r.u64()), issued: Number(r.u64()), revealed: Number(r.u64()) };
  r.done();
  return out;
}

export function v2Address(): ContractAddress.Type | undefined {
  const idx = process.env.REGISTRY_V2_CONTRACT;
  return idx ? ContractAddress.create(BigInt(idx), 0n) : undefined;
}

const ab = (b: Buffer) => new Uint8Array(b).buffer as ArrayBuffer;
const method = (entry: string) => ReceiveName.create(ContractName.fromString(CONTRACT_V2_NAME), EntrypointName.fromString(entry));

/** 唯讀查詢（不需要金鑰） */
export function createV2Reader(contract: ContractAddress.Type, grpc = createGrpc()) {
  const view = async (entry: string, param: Buffer) => {
    const res = await grpc.invokeContract({ contract, method: method(entry), parameter: Parameter.fromBuffer(ab(param)) });
    if (res.tag !== "success" || !res.returnValue) throw new Error(`${entry} view failed`);
    return Buffer.from(ReturnValue.toHexString(res.returnValue), "hex");
  };
  return {
    grpc,
    slot: async (asset: string, asOf: string) => decodeSlotV2(await view("slot", encodeSlotV2(asset, asOf))),
    summary: async () => decodeSummaryV2(await view("view", Buffer.alloc(0))),
  };
}

/** 鏈上明確拒絕（不是網路或等待逾時） */
export class RejectedError extends Error {}

/** 同一個帳號：Concordium 的別名帳號前 29 個位元組相同 */
export const sameAccount = (a: string, b: string) =>
  Buffer.from(AccountAddress.fromBase58(a).decodedAddress).subarray(0, 29).equals(Buffer.from(AccountAddress.fromBase58(b).decodedAddress).subarray(0, 29));

/** 寫入（上鏈帳號 commit／任何人 reveal／擁有者設定）：同帳號排隊、等最終確認，失敗就丟錯 */
export function createV2Writer(keyFile: string, contract: ContractAddress.Type) {
  const acct = loadAccount(keyFile);
  const reader = createV2Reader(contract);
  const grpc = reader.grpc;
  /** 只留拒絕原因的種類與錯誤碼：參數（例如還沒公開的 canonical）不能進 log */
  const reason = (s: any) => {
    const r = s?.rejectReason ?? {};
    const code = r.rejectReason !== undefined ? ` code ${String(r.rejectReason)}` : "";
    return `${String(r.tag ?? s?.transactionType ?? "unknown")}${code}`;
  };
  const update = (entry: string, param: Buffer, energy = 30_000, onSent?: (tx: string) => Promise<void>) =>
    serialize(acct.address, async () => {
      const fromNode = (await grpc.getNextAccountNonce(acct.accountAddress)).nonce.value;
      const nonce = SequenceNumber.create(pickNonce(acct.address, fromNode));
      const tx = Transaction.updateContract(
        { amount: CcdAmount.zero(), address: contract, receiveName: method(entry), message: Parameter.fromBuffer(ab(param)) },
        Energy.create(energy),
      )
        .addMetadata({ sender: acct.accountAddress, nonce, expiry: TransactionExpiry.futureMinutes(5) })
        .build();
      let hash: TransactionHash.Type;
      try {
        hash = await grpc.sendTransaction(await Transaction.signAndFinalize(tx, acct.signer));
      } catch (e) {
        forgetNonce(acct.address);
        throw e;
      }
      const txHex = TransactionHash.toHexString(hash);
      if (onSent) await onSent(txHex); // 先記下交易，再等確認：等待失敗時下一輪仍知道這筆交易
      const out = await grpc.waitForTransactionFinalization(hash, 180_000);
      const s = out.summary as any;
      if (s.transactionType === "failed" || s.rejectReason) throw new RejectedError(`${entry} rejected (${txHex}): ${reason(s)}`);
      return txHex;
    });
  return {
    address: acct.address,
    ...reader,
    commit: (asset: string, asOf: string, commitment: string, onSent?: (tx: string) => Promise<void>) =>
      update("commit", encodeCommitV2(asset, asOf, commitment), 30_000, onSent),
    reveal: (canonical: string) => update("reveal", encodeRevealV2(canonical), 60_000),
    setCommitter: (addr: string) => update("set_committer", encodeAccount(addr)),
    revokeCommitter: () => update("revoke_committer", Buffer.alloc(0)),
  };
}

async function deploy() {
  const owner = loadAccount(env("REGISTRY_OWNER_KEY_FILE", env("FACILITATOR_KEY_FILE")));
  const grpc = createGrpc();
  const source = process.env.CONTRACT_MODULE ? readFileSync(process.env.CONTRACT_MODULE) : Buffer.from(await (await fetch(MODULE_V2_URL)).arrayBuffer());
  const refHex = createHash("sha256").update(source).digest("hex");
  console.log(`owner  ${owner.address}\nmodule ${refHex} (${source.length} bytes)`);
  const submit = async (tx: any) => {
    const { nonce } = await grpc.getNextAccountNonce(owner.accountAddress);
    const built = tx.addMetadata({ sender: owner.accountAddress, nonce, expiry: TransactionExpiry.futureMinutes(5) }).build();
    const hash = await grpc.sendTransaction(await Transaction.signAndFinalize(built, owner.signer));
    const hex = TransactionHash.toHexString(hash);
    console.log(`  tx https://ccdexplorer.io/testnet/transaction/${hex}`);
    return { hex, summary: (await grpc.waitForTransactionFinalization(hash, 180_000)).summary as any };
  };
  const moduleRef = ModuleReference.fromHexString(refHex);
  if (await grpc.getModuleSource(moduleRef).then(() => true, () => false)) console.log("1/2 module already on chain");
  else {
    console.log("1/2 deploying module…");
    const dep = await submit(Transaction.deployModule({ source: new Uint8Array(source) }));
    if (dep.summary.transactionType === "failed") throw new Error(`deploy failed: ${JSON.stringify(dep.summary.rejectReason).slice(0, 400)}`);
  }
  console.log("2/2 creating contract…");
  const init = await submit(
    Transaction.initContract({ amount: CcdAmount.zero(), moduleRef, initName: ContractName.fromString(CONTRACT_V2_NAME), param: Parameter.empty() }, Energy.create(30_000)),
  );
  const inst = init.summary.contractInitialized;
  if (!inst?.address) throw new Error(`init failed: ${JSON.stringify(init.summary.rejectReason ?? init.summary).slice(0, 400)}`);
  console.log(`\n✅ contract v2 <${inst.address.index},${inst.address.subindex}>\n   module ${refHex}\n   init tx ${init.hex}`);
  console.log(`add to gateway/.env:  REGISTRY_V2_CONTRACT=${inst.address.index}`);
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "deploy") return deploy();
  const address = v2Address();
  if (!address) throw new Error("set REGISTRY_V2_CONTRACT=<index> in gateway/.env first (printed by `deploy`)");
  const show = (x: unknown) => console.log(JSON.stringify(x, null, 2));
  if (cmd === "status") return show(await createV2Reader(address).summary());
  if (cmd === "slot") return show(await createV2Reader(address).slot(a, b));
  const owner = () => createV2Writer(env("REGISTRY_OWNER_KEY_FILE", env("FACILITATOR_KEY_FILE")), address);
  if (cmd === "set-committer") {
    if (!a) throw new Error("usage: set-committer <account address>");
    const w = owner();
    if (sameAccount(a, w.address)) throw new Error("the committer cannot be the owner or an alias of it");
    return console.log(`set_committer ${a}: https://ccdexplorer.io/testnet/transaction/${await w.setCommitter(a)}`);
  }
  if (cmd === "revoke-committer") return console.log(`revoked: https://ccdexplorer.io/testnet/transaction/${await owner().revokeCommitter()}`);
  console.log("usage: npm run contract2 -- deploy | set-committer <account> | revoke-committer | status | slot <BTC|ETH> <YYYY-MM-DD>");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0), (e) => {
    console.error("❌", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
