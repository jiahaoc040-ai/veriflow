/**
 * Deploying and using the VeriFlow registry smart contract v1 (Rust, contract/; retired, replaced by contract-v2)
 * ---------------------------------------------------------------
 * The contract turns commit–reveal into rules enforced on-chain:
 *   commit  only the seller can write; block time recorded; nothing is overwritten
 *   reveal  anyone can reveal after the horizon; the chain computes SHA-256 itself and rejects a mismatch
 *
 * Usage (in gateway/):
 *   npm run contract -- deploy [horizonDays=7]   deploy the CI-built module and create the contract; prints its address
 *   npm run contract -- status                    total count (REGISTRY_CONTRACT)
 *   npm run contract -- show <commitment>         look up a commitment and its revealed content
 *   npm run contract -- reveal <commitment>       after the horizon, fetch the content from the API and reveal it on-chain
 *
 * With REGISTRY_CONTRACT=<index> set, every paid signal from the gateway is committed through the contract.
 */
import { NET } from "./network.js";
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
  SequenceNumber,
} from "@concordium/web-sdk";
import { env, loadAccount } from "./config.js";
import { forgetNonce, pickNonce, serialize } from "./txqueue.js";
import { createGrpc } from "./grpc.js";

export const CONTRACT_NAME = "veriflow_registry";
/** VeriFlow's v1 contract on testnet, <13094,0> (buyer agents accept commitment events only from this contract) */
export const TESTNET_REGISTRY_INDEX = 13094n;
export const MODULE_URL = "https://github.com/jiahaoc040-ai/veriflow/releases/download/registry-module/module.wasm.v1";
const DAY_MS = 24 * 3600 * 1000;

// ── Binary format of parameters and return values (same as Rust concordium-std Serial) ──────────
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
/** The SDK needs a standalone ArrayBuffer (not a Buffer slice of shared memory) */
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

/** Contract event Committed (tag 0): tag ‖ commitment(32) ‖ asset ‖ committed_at */
export function decodeCommittedEvent(hex: string): { commitment: string; asset: string } | null {
  const b = Buffer.from(hex, "hex");
  if (b[0] !== 0 || b.length < 37) return null;
  const r = new Reader(b.subarray(1));
  const commitment = r.bytes(32).toString("hex");
  return { commitment, asset: r.str() };
}

// ── On-chain operations ────────────────────────────────────────────────────────────────
export function registryAddress(): ContractAddress.Type | undefined {
  const idx = process.env.REGISTRY_CONTRACT;
  return idx ? ContractAddress.create(BigInt(idx), 0n) : undefined;
}

const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

export function createRegistryClient(keyFile: string, contract: ContractAddress.Type) {
  const owner = loadAccount(keyFile);
  const grpc = createGrpc();

  // The operator account's transactions are queued so nonces never collide (see txqueue.ts)
  function send(tx: ReturnType<typeof Transaction.updateContract>) {
    return serialize(owner.address, async () => {
      const fromNode = (await grpc.getNextAccountNonce(owner.accountAddress)).nonce.value;
      const nonce = SequenceNumber.create(pickNonce(owner.address, fromNode));
      const built = tx.addMetadata({ sender: owner.accountAddress, nonce, expiry: TransactionExpiry.futureMinutes(5) }).build();
      try {
        const hash = await grpc.sendTransaction(await Transaction.signAndFinalize(built, owner.signer));
        return TransactionHash.toHexString(hash);
      } catch (e) {
        forgetNonce(owner.address);
        throw e;
      }
    });
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
    /** Commit a paid signal: returns the transaction hash (does not wait for finalization, like register data) */
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
    console.log(`  tx ${NET.explorer}/transaction/${TransactionHash.toHexString(hash)}`);
    return (await grpc.waitForTransactionFinalization(hash, 120_000)).summary as any;
  };

  // Module reference = SHA-256 of the versioned module file (.wasm.v1); not resent if already on-chain
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
    // Content comes from the VeriFlow API (public only after the horizon)
    const api = env("API_URL", "http://localhost:8000");
    const c = (await (await fetch(`${api}/commitments/${arg}`)).json()) as { canonical?: string; revealed?: boolean };
    if (!c.canonical) throw new Error("not revealed yet by the API (horizon not reached)");
    const tx = await client.reveal(c.canonical);
    return console.log(`reveal sent: ${NET.explorer}/transaction/${tx}`);
  }
  console.log("usage: npm run contract -- deploy [horizonDays] | status | show <commitment> | reveal <commitment>");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("❌", e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
