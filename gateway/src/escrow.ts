/**
 * VeriFlow agent escrow (contract-escrow/): the guard's payout rule enforced on-chain
 * ----------------------------------------------------------------------------------
 * A payment can only ever reach the on-chain agentWallet of an Active CIS-8004 agent: the contract reads agentOf from
 * the registry itself, when the buyer pays and again when the money is paid out. Anything else is a rejected
 * transaction with an error code (see ERRORS), visible on CCDScan.
 *
 * Usage (in gateway/):
 *   npm run escrow -- deploy                               create the contract from the CI-built module (any funded key: ESCROW_DEPLOY_KEY_FILE, else BUYER_KEY_FILE)
 *   npm run escrow -- pay <token id> <ccd> [minutes] [memo] buyer (BUYER_KEY_FILE) pays into escrow for that agent; dispute window in minutes (default 60)
 *   npm run escrow -- release <escrow id>                  buyer: pay the agent's current agentWallet
 *   npm run escrow -- refund <escrow id>                   buyer: during the window, or once the agent can no longer be paid
 *   npm run escrow -- claim <escrow id>                    the agent's wallet (ESCROW_CLAIM_KEY_FILE), after the window
 *   npm run escrow -- check <token id>                     dry run of pay for 1 microCCD: would the contract accept this agent? (nothing is sent)
 *   npm run escrow -- status [escrow id]
 * pay/release/refund/claim first dry-run the call; if the contract would reject it, nothing is sent unless you add --send-anyway
 * (useful once, to leave a rejected transaction on-chain as evidence; it costs the fee, and no CCD moves).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  AccountAddress,
  CcdAmount,
  ContractAddress,
  ContractName,
  Energy,
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
import { NET, txLink } from "./network.js";

export const ESCROW_NAME = "veriflow_escrow";
/** The verifiable build CI made from contract-escrow/ (cargo concordium verify-build: "Source and module match") */
export const EXPECTED_MODULE = "0094e91830a15ece653402e75eaf0d8c841df3d4e7d6c9bff35698b9be821457";
export const MODULE_URL = "https://github.com/jiahaoc040-ai/veriflow/releases/download/escrow-module/verified.wasm.v1";

/** Rejection codes, in the order of the contract's Error enum (-1, -2, …) */
export const ERRORS = [
  "ParseParams", "AgentNotFound", "AgentNotActive", "AgentHasNoWallet", "OnlyAccount", "ZeroAmount", "NotBuyer", "NotHeld",
  "TooEarly", "TooLate", "NotAgentWallet", "UnknownEscrow", "RegistryCallFailed", "BadAgentRecord", "BadWindow", "MemoTooLong",
  "TransferFailed", "LogFull", "SelfPayment", "WrongAgent", "NotPayable", "WalletChanged", "WalletNotAnAccount",
] as const;
export const errorName = (code: number) => (code < 0 && -code <= ERRORS.length ? ERRORS[-code - 1] : `code ${code}`);

const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

export function encodePay(tokenId: bigint, minutes: number, memo: string): Buffer {
  const m = Buffer.from(memo, "utf8");
  if (m.length > 64) throw new Error("memo: at most 64 bytes");
  return Buffer.concat([u64(tokenId), u32(minutes), u32(m.length), m]);
}

export function encodeInit(registry: { index: bigint; subindex: bigint }): Buffer {
  return Buffer.concat([u64(registry.index), u64(registry.subindex)]);
}

export type EscrowRecord = {
  buyer: string; tokenId: string; amountMicroCcd: bigint; paidAt: Date; claimAfter: Date; walletAtPay: string; memo: string;
  state: "Held" | "Released" | "Claimed" | "Refunded"; paidTo: string | null;
};

export function decodeEscrow(buf: Buffer): EscrowRecord | null {
  let o = 0;
  const acct = () => { const a = AccountAddress.toBase58(AccountAddress.fromBuffer(new Uint8Array(buf.subarray(o, o + 32)).buffer as ArrayBuffer)); o += 32; return a; };
  const r64 = () => { const v = buf.readBigUInt64LE(o); o += 8; return v; };
  if (buf[o++] !== 1) return null;
  const buyer = acct();
  const tokenId = r64().toString();
  const amountMicroCcd = r64();
  const paidAt = new Date(Number(r64()));
  const claimAfter = new Date(Number(r64()));
  const walletAtPay = acct();
  const n = buf.readUInt32LE(o); o += 4;
  const memo = buf.subarray(o, o + n).toString("utf8"); o += n;
  const state = (["Held", "Released", "Claimed", "Refunded"] as const)[buf[o++]];
  const paidTo = buf[o++] === 1 ? acct() : null;
  return { buyer, tokenId, amountMicroCcd, paidAt, claimAfter, walletAtPay, memo, state, paidTo };
}

/** The reject code of a failed invoke or transaction, as -n */
function rejectCode(x: any): number | undefined {
  const r = x?.reason ?? x?.rejectReason ?? x;
  const v = r?.rejectReason ?? r?.reason?.rejectReason;
  return typeof v === "number" ? v : undefined;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const sendAnyway = args.includes("--send-anyway");
  const rest = args.filter((a) => a !== "--send-anyway");
  const grpc = createGrpc();
  const contractOf = () => ContractAddress.create(BigInt(env("ESCROW_CONTRACT")), 0n);
  const method = (e: string) => ReceiveName.fromString(`${ESCROW_NAME}.${e}`);

  const send = async (keyFile: string, entry: string, param: Buffer, microCcd: bigint) => {
    const acct = loadAccount(keyFile);
    const contract = contractOf();
    const dry = await grpc.invokeContract({ contract, invoker: acct.accountAddress, method: method(entry), parameter: Parameter.fromBuffer(new Uint8Array(param).buffer as ArrayBuffer), amount: CcdAmount.fromMicroCcd(microCcd) });
    if (dry.tag !== "success") {
      const code = rejectCode(dry);
      console.log(`the contract would reject ${entry}: ${code !== undefined ? `${code} ${errorName(code)}` : JSON.stringify(dry).slice(0, 200)}`);
      if (!sendAnyway) { console.log("nothing sent (add --send-anyway to put the rejected transaction on-chain as evidence)"); process.exit(1); }
    }
    const { nonce } = await grpc.getNextAccountNonce(acct.accountAddress);
    const tx = Transaction.updateContract(
      { amount: CcdAmount.fromMicroCcd(microCcd), address: contract, receiveName: method(entry), message: Parameter.fromBuffer(new Uint8Array(param).buffer as ArrayBuffer) },
      Energy.create(60_000),
    ).addMetadata({ sender: acct.accountAddress, nonce, expiry: TransactionExpiry.futureMinutes(5) }).build();
    const hash = await grpc.sendTransaction(await Transaction.signAndFinalize(tx, acct.signer));
    const hex = TransactionHash.toHexString(hash);
    console.log(`${entry} by ${acct.address}\n  tx ${txLink(hex)}`);
    const s = (await grpc.waitForTransactionFinalization(hash, 180_000)).summary as any;
    if (s.transactionType === "failed" || s.rejectReason) {
      const code = rejectCode(s);
      console.log(`  ⛔ rejected on-chain: ${code !== undefined ? `${code} ${errorName(code)}` : JSON.stringify(s.rejectReason).slice(0, 200)} (no CCD moved)`);
      return { hex, ok: false, summary: s };
    }
    console.log("  ✅ finalized");
    return { hex, ok: true, summary: s };
  };

  if (cmd === "deploy") {
    const owner = loadAccount(process.env.ESCROW_DEPLOY_KEY_FILE ?? env("BUYER_KEY_FILE"));
    const source = process.env.CONTRACT_MODULE ? readFileSync(process.env.CONTRACT_MODULE) : Buffer.from(await (await fetch(MODULE_URL)).arrayBuffer());
    const refHex = createHash("sha256").update(source).digest("hex");
    const expected = process.env.EXPECTED_ESCROW_MODULE ?? EXPECTED_MODULE;
    console.log(`deployer ${owner.address}\nmodule ${refHex} (${source.length} bytes)`);
    // Deploy only the reviewed, verifiable module; anything else stops here and nothing is sent
    if (refHex !== expected) throw new Error(`module ${refHex} is not the reviewed module ${expected}; nothing was sent`);
    const submit = async (tx: any) => {
      const { nonce } = await grpc.getNextAccountNonce(owner.accountAddress);
      const built = tx.addMetadata({ sender: owner.accountAddress, nonce, expiry: TransactionExpiry.futureMinutes(5) }).build();
      const hash = await grpc.sendTransaction(await Transaction.signAndFinalize(built, owner.signer));
      const hex = TransactionHash.toHexString(hash);
      console.log(`  tx ${txLink(hex)}`);
      return { hex, summary: (await grpc.waitForTransactionFinalization(hash, 180_000)).summary as any };
    };
    const moduleRef = ModuleReference.fromHexString(refHex);
    if (await grpc.getModuleSource(moduleRef).then(() => true, () => false)) console.log("1/2 module already on chain");
    else {
      console.log("1/2 deploying module…");
      const dep = await submit(Transaction.deployModule({ source: new Uint8Array(source) }));
      if (dep.summary.transactionType === "failed") throw new Error(`deploy failed: ${JSON.stringify(dep.summary.rejectReason).slice(0, 300)}`);
    }
    console.log(`2/2 creating the escrow for the CIS-8004 registry <${NET.agentRegistry.index},${NET.agentRegistry.subindex}>…`);
    const init = await submit(Transaction.initContract({ amount: CcdAmount.zero(), moduleRef, initName: ContractName.fromString(ESCROW_NAME), param: Parameter.fromBuffer(new Uint8Array(encodeInit(NET.agentRegistry)).buffer as ArrayBuffer) }, Energy.create(30_000)));
    const inst = init.summary.contractInitialized;
    if (!inst?.address) throw new Error(`init failed: ${JSON.stringify(init.summary.rejectReason ?? init.summary).slice(0, 300)}`);
    console.log(`\n✅ escrow <${inst.address.index},${inst.address.subindex}>\n   module ${refHex}\n   init tx ${init.hex}\nadd to gateway/.env:  ESCROW_CONTRACT=${inst.address.index}`);
    return;
  }
  if (cmd === "pay") {
    const [id, ccd, minutes = "60", ...memo] = rest;
    if (!/^\d+$/.test(id ?? "") || !/^\d+(\.\d{1,6})?$/.test(ccd ?? "")) throw new Error("usage: pay <token id> <ccd> [minutes] [memo]");
    const micro = BigInt(Math.round(Number(ccd) * 1e6));
    if (micro > BigInt(env("ESCROW_MAX_MICROCCD", "5000000"))) throw new Error(`refusing to escrow more than ${Number(env("ESCROW_MAX_MICROCCD", "5000000")) / 1e6} CCD (ESCROW_MAX_MICROCCD)`);
    const r = await send(env("BUYER_KEY_FILE"), "pay", encodePay(BigInt(id), Number(minutes), memo.join(" ") || `veriflow ${new Date().toISOString().slice(0, 10)}`), micro);
    if (r.ok) {
      // The newest escrow id: view returns next_id, and ids are given out one by one
      const v = await grpc.invokeContract({ contract: contractOf(), method: method("view"), parameter: Parameter.empty() });
      if (v.tag === "success" && v.returnValue) console.log(`  escrow id ${Buffer.from(ReturnValue.toHexString(v.returnValue), "hex").readBigUInt64LE(16) - 1n} (then: npm run escrow -- release <id>)`);
    }
    return;
  }
  if (cmd === "release" || cmd === "refund" || cmd === "claim") {
    const id = rest[0];
    if (!/^\d+$/.test(id ?? "")) throw new Error(`usage: ${cmd} <escrow id>`);
    const key = cmd === "claim" ? env("ESCROW_CLAIM_KEY_FILE") : env("BUYER_KEY_FILE");
    await send(key, cmd, u64(BigInt(id)), 0n);
    return;
  }
  if (cmd === "check") {
    const id = rest[0];
    if (!/^\d+$/.test(id ?? "")) throw new Error("usage: check <token id>");
    const buyer = loadAccount(env("BUYER_KEY_FILE"));
    const r = await grpc.invokeContract({ contract: contractOf(), invoker: buyer.accountAddress, method: method("pay"), parameter: Parameter.fromBuffer(new Uint8Array(encodePay(BigInt(id), 60, "check")).buffer as ArrayBuffer), amount: CcdAmount.fromMicroCcd(1n) });
    const code = r.tag === "success" ? undefined : rejectCode(r);
    console.log(r.tag === "success" ? `agent #${id}: the escrow would accept a payment (nothing sent)` : `agent #${id}: the escrow would reject it: ${code} ${errorName(code ?? 0)} (nothing sent)`);
    return;
  }
  if (cmd === "status") {
    const id = rest[0];
    if (id) {
      const r = await grpc.invokeContract({ contract: contractOf(), method: method("escrow"), parameter: Parameter.fromBuffer(new Uint8Array(u64(BigInt(id))).buffer as ArrayBuffer) });
      if (r.tag !== "success" || !r.returnValue) throw new Error("escrow read failed");
      const e = decodeEscrow(Buffer.from(ReturnValue.toHexString(r.returnValue), "hex"));
      console.log(e ? { ...e, amount: `${Number(e.amountMicroCcd) / 1e6} CCD`, amountMicroCcd: undefined } : `no escrow ${id}`);
    } else {
      const r = await grpc.invokeContract({ contract: contractOf(), method: method("view"), parameter: Parameter.empty() });
      if (r.tag !== "success" || !r.returnValue) throw new Error("view failed");
      const b = Buffer.from(ReturnValue.toHexString(r.returnValue), "hex");
      console.log(`escrow <${env("ESCROW_CONTRACT")},0>  registry <${b.readBigUInt64LE(0)},${b.readBigUInt64LE(8)}>  escrows so far ${b.readBigUInt64LE(16)}`);
    }
    return;
  }
  console.log("usage: npm run escrow -- deploy | pay <token id> <ccd> [minutes] [memo] | release|refund|claim <escrow id> | check <token id> | status [escrow id]  (add --send-anyway to send a call the contract would reject)");
  process.exit(2);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
