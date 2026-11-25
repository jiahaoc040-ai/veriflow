/**
 * Off-chain tools for VeriFlow contract v2 (contract-v2/)
 * ------------------------------------------
 * Contract rules: one commit per (asset, as_of), only within the day after the as_of close, BTC/ETH and 7 days hard-coded,
 * a cold owner appoints one committer (never itself), and on reveal the contract checks the format, key and rules.
 *
 * Usage (in gateway/, owner key REGISTRY_OWNER_KEY_FILE = 4dNM, run only on your own machine):
 *   npm run contract2 -- deploy                 deploy the CI-built v2 module and create the contract; prints contract, module and init tx
 *   npm run contract2 -- set-committer <account> appoint the committer (replaces the previous one)
 *   npm run contract2 -- revoke-committer       revoke the committer (for emergencies)
 *   npm run contract2 -- status                 contract summary (REGISTRY_V2_CONTRACT)
 *   npm run contract2 -- slot <BTC|ETH> <YYYY-MM-DD>
 */
import { NET, txLink } from "./network.js";
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
/** The reviewed v2 module (built by CI from commit 5e699ad, 38,414 bytes) */
export const EXPECTED_MODULE_V2 = "08e3b49e4e6d0a11f1d2af4c6754537d695cfe19945b9b6d7fb5b8722f4df6cc";
export const DAY_MS = 86_400_000;
export const HORIZON_MS = 7 * DAY_MS;

// ── Encoding ──
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

// ── Decoding ──
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

/** The v2 contract deployed on testnet (init dba400c2…, module 08e3b49e…) */
export const TESTNET_REGISTRY_V2_INDEX = 13115n;

export function v2Address(): ContractAddress.Type | undefined {
  const idx = process.env.REGISTRY_V2_CONTRACT;
  return idx ? ContractAddress.create(BigInt(idx), 0n) : undefined;
}

/** v2 Committed event (tag 0): asset, as_of, commitment, committed_at; other events return null */
export function decodeCommittedEventV2(hex: string): { asset: string; as_of: string; commitment: string; committed_at: string } | null {
  try {
    const r = new Reader(Buffer.from(hex, "hex"));
    if (r.u8() !== 0) return null;
    const asset = r.str();
    const as_of = r.str();
    const commitment = r.bytes(32).toString("hex");
    const committed_at = iso(r.u64());
    r.done();
    return { asset, as_of, commitment, committed_at };
  } catch {
    return null;
  }
}

const ab = (b: Buffer) => new Uint8Array(b).buffer as ArrayBuffer;
const method = (entry: string) => ReceiveName.create(ContractName.fromString(CONTRACT_V2_NAME), EntrypointName.fromString(entry));

/** Read-only queries (no key needed) */
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

/** An explicit rejection by the chain (not a network error or a wait timeout) */
export class RejectedError extends Error {}

/** Same account: Concordium account aliases share the first 29 bytes */
export const sameAccount = (a: string, b: string) =>
  Buffer.from(AccountAddress.fromBase58(a).decodedAddress).subarray(0, 29).equals(Buffer.from(AccountAddress.fromBase58(b).decodedAddress).subarray(0, 29));

/** Writes (committer commit / anyone reveal / owner settings): queued per account, wait for finalization, throw on failure */
export function createV2Writer(keyFile: string, contract: ContractAddress.Type) {
  const acct = loadAccount(keyFile);
  const reader = createV2Reader(contract);
  const grpc = reader.grpc;
  /** Keep only the kind of rejection and its code: parameters (e.g. a canonical not yet revealed) must never reach the logs */
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
      if (onSent) await onSent(txHex); // record the transaction before waiting, so the next run knows about it even if the wait fails
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
  // Deploy only the reviewed module (built by CI from 5e699ad); anything else stops here and nothing is sent
  if (refHex !== EXPECTED_MODULE_V2) throw new Error(`module ${refHex} is not the reviewed module ${EXPECTED_MODULE_V2}; nothing was sent`);
  const submit = async (tx: any) => {
    const { nonce } = await grpc.getNextAccountNonce(owner.accountAddress);
    const built = tx.addMetadata({ sender: owner.accountAddress, nonce, expiry: TransactionExpiry.futureMinutes(5) }).build();
    const hash = await grpc.sendTransaction(await Transaction.signAndFinalize(built, owner.signer));
    const hex = TransactionHash.toHexString(hash);
    console.log(`  tx ${NET.explorer}/transaction/${hex}`);
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
  // Without configuration, use the contract deployed on testnet, <13115,0>
  const address = v2Address() ?? ContractAddress.create(TESTNET_REGISTRY_V2_INDEX, 0n);
  const show = (x: unknown) => console.log(JSON.stringify(x, null, 2));
  if (cmd === "status") return show(await createV2Reader(address).summary());
  if (cmd === "slot") return show(await createV2Reader(address).slot(a, b));
  const owner = () => createV2Writer(env("REGISTRY_OWNER_KEY_FILE", env("FACILITATOR_KEY_FILE")), address);
  if (cmd === "set-committer") {
    if (!a) throw new Error("usage: set-committer <account address>");
    const w = owner();
    if (sameAccount(a, w.address)) throw new Error("the committer cannot be the owner or an alias of it");
    return console.log(`set_committer ${a}: ${NET.explorer}/transaction/${await w.setCommitter(a)}`);
  }
  if (cmd === "prove-rejection") {
    // Demo: the committer deliberately sends two commits that break the rules, leaving transactions the contract rejected on-chain (each costs only a small fee)
    const w = createV2Writer(env("COMMITTER_KEY_FILE"), address);
    const day = (n: number) => new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
    const randomHash = () => createHash("sha256").update(String(Math.random())).digest("hex");
    const attempts: [string, string, string][] = [
      ["a second call for a day that already has one", "BTC", day(1)],
      ["a late call, three days after its close", "BTC", day(3)],
    ];
    // Safety valve: send the duplicate only if yesterday's BTC already has a real commit; otherwise this random hash would become that day's only commit
    const reader = createV2Reader(address);
    if (!(await reader.slot("BTC", day(1)))) throw new Error(`BTC ${day(1)} has no commit yet; wait for the daily job (after ~00:20 UTC) so the duplicate cannot become the real call`);
    for (const [what, asset, asOf] of attempts) {
      let sent: string | undefined;
      try {
        const tx = await w.commit(asset, asOf, randomHash(), async (h) => void (sent = h));
        console.log(`✗ UNEXPECTED: ${what} was accepted: ${txLink(tx)}`);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        if (e instanceof RejectedError) console.log(`✓ rejected by the chain — ${what} (${asset} ${asOf}): ${txLink(sent ?? /\(([0-9a-f]{64})\)/.exec(m)?.[1] ?? "?")}`);
        else console.log(`? outcome unknown — ${what} (${asset} ${asOf})${sent ? `: sent ${txLink(sent)}, open it to see the result` : ""}: ${m}`);
      }
    }
    return;
  }
  if (cmd === "revoke-committer") return console.log(`revoked: ${NET.explorer}/transaction/${await owner().revokeCommitter()}`);
  console.log("usage: npm run contract2 -- deploy | set-committer <account> | revoke-committer | status | slot <BTC|ETH> <YYYY-MM-DD> | prove-rejection");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then(() => process.exit(0), (e) => {
    console.error("❌", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
