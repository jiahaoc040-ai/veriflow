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
  SequenceNumber,
  Transaction,
  TransactionExpiry,
  TransactionHash,
} from "@concordium/web-sdk";
import { env, loadAccount } from "./config.js";
import { createGrpc } from "./grpc.js";
import { NET, txLink } from "./network.js";
import { isMain } from "./is-main.js";

export const ESCROW_NAME = "veriflow_escrow";
/** The verifiable build CI made from contract-escrow/ (cargo concordium verify-build: "Source and module match") */
export const EXPECTED_MODULE = "b1b62b091aac44fa10a866224f20bfa213fd5aa5f4a6b77e53d00b5235ff302e";
/** The first escrow, <13170,0>: payout followed the registry's current wallet; superseded after an outside review */
export const V1_MODULE = "0094e91830a15ece653402e75eaf0d8c841df3d4e7d6c9bff35698b9be821457";
export const MODULE_URL = "https://github.com/jiahaoc040-ai/veriflow/releases/download/escrow-module-v2/verified.wasm.v1";

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

type Grpc = ReturnType<typeof createGrpc>;
type Account = ReturnType<typeof loadAccount>;
const asParam = (b: Buffer) => Parameter.fromBuffer(new Uint8Array(b).buffer as ArrayBuffer);
const method = (e: string) => ReceiveName.fromString(`${ESCROW_NAME}.${e}`);
export const escrowU64 = (n: bigint) => u64(n);

export type EscrowCall = { hex?: string; ok: boolean; code?: number; error?: string; dryRunOnly: boolean; transfers: { to: string; microCcd: bigint }[]; summary?: any };

/** CCD transfers the contract made in a finalized update (the payout of release/claim/refund) */
export function transfersOf(summary: any): { to: string; microCcd: bigint }[] {
  const out: { to: string; microCcd: bigint }[] = [];
  for (const ev of summary?.events ?? []) {
    if (ev?.tag !== "Transferred") continue;
    const to = ev.to?.address ?? ev.to;
    const amount = ev.amount?.microCcdAmount ?? ev.amount;
    try { out.push({ to: typeof to === "string" ? to : AccountAddress.toBase58(to), microCcd: BigInt(amount) }); } catch { /* not an account transfer */ }
  }
  return out;
}

/**
 * Dry-run an escrow entrypoint as `acct`, then (if it would succeed, or sendAnyway) send it and wait for finalization.
 * A nonce lock (serialize/pickNonce) is the caller's job when the account is shared.
 */
export async function escrowSend(grpc: Grpc, contract: ContractAddress.Type, acct: Account, entry: string, param: Buffer, microCcd: bigint, opts: { sendAnyway?: boolean; nonce?: (fromNode: bigint) => bigint; log?: (m: string) => void } = {}): Promise<EscrowCall> {
  const log = opts.log ?? (() => {});
  const dry = await grpc.invokeContract({ contract, invoker: acct.accountAddress, method: method(entry), parameter: asParam(param), amount: CcdAmount.fromMicroCcd(microCcd) });
  if (dry.tag !== "success") {
    const code = rejectCode(dry);
    log(`the contract would reject ${entry}: ${code !== undefined ? `${code} ${errorName(code)}` : JSON.stringify(dry).slice(0, 200)}`);
    if (!opts.sendAnyway) return { ok: false, code, error: code !== undefined ? errorName(code) : "dry_run_failed", dryRunOnly: true, transfers: [] };
  }
  const fromNode = (await grpc.getNextAccountNonce(acct.accountAddress)).nonce;
  const nonce = opts.nonce ? SequenceNumber.create(opts.nonce(fromNode.value)) : fromNode;
  const tx = Transaction.updateContract(
    { amount: CcdAmount.fromMicroCcd(microCcd), address: contract, receiveName: method(entry), message: asParam(param) },
    Energy.create(60_000),
  ).addMetadata({ sender: acct.accountAddress, nonce, expiry: TransactionExpiry.futureMinutes(5) }).build();
  const hash = await grpc.sendTransaction(await Transaction.signAndFinalize(tx, acct.signer));
  const hex = TransactionHash.toHexString(hash);
  log(`${entry} by ${acct.address}\n  tx ${txLink(hex)}`);
  const s = (await grpc.waitForTransactionFinalization(hash, 180_000)).summary as any;
  if (s.transactionType === "failed" || s.rejectReason) {
    const code = rejectCode(s);
    log(`  ⛔ rejected on-chain: ${code !== undefined ? `${code} ${errorName(code)}` : JSON.stringify(s.rejectReason).slice(0, 200)} (no CCD moved)`);
    return { hex, ok: false, code, error: code !== undefined ? errorName(code) : "rejected", dryRunOnly: false, transfers: [], summary: s };
  }
  log("  ✅ finalized");
  return { hex, ok: true, dryRunOnly: false, transfers: transfersOf(s), summary: s };
}

/** Would the contract accept a payment for this agent? Read-only, nothing is sent */
export async function escrowWouldAccept(grpc: Grpc, contract: ContractAddress.Type, invoker: AccountAddress.Type, tokenId: bigint): Promise<{ ok: boolean; code?: number; error?: string }> {
  const r = await grpc.invokeContract({ contract, invoker, method: method("pay"), parameter: asParam(encodePay(tokenId, 60, "check")), amount: CcdAmount.fromMicroCcd(1n) });
  if (r.tag === "success") return { ok: true };
  const code = rejectCode(r);
  return { ok: false, code, error: code !== undefined ? errorName(code) : "dry_run_failed" };
}

export async function escrowNextId(grpc: Grpc, contract: ContractAddress.Type): Promise<{ registry: string; nextId: bigint }> {
  const r = await grpc.invokeContract({ contract, method: method("view"), parameter: Parameter.empty() });
  if (r.tag !== "success" || !r.returnValue) throw new Error("view failed");
  const b = Buffer.from(ReturnValue.toHexString(r.returnValue), "hex");
  return { registry: `<${b.readBigUInt64LE(0)},${b.readBigUInt64LE(8)}>`, nextId: b.readBigUInt64LE(16) };
}

export async function escrowRead(grpc: Grpc, contract: ContractAddress.Type, id: bigint): Promise<EscrowRecord | null> {
  const r = await grpc.invokeContract({ contract, method: method("escrow"), parameter: asParam(u64(id)) });
  if (r.tag !== "success" || !r.returnValue) throw new Error("escrow read failed");
  return decodeEscrow(Buffer.from(ReturnValue.toHexString(r.returnValue), "hex"));
}

/** The escrow id a successful pay created: the contract logs nothing else we need, so read it back by buyer + memo among the newest ids */
export async function escrowIdOf(grpc: Grpc, contract: ContractAddress.Type, buyer: string, memo: string, lookBack = 10n): Promise<bigint | null> {
  const { nextId } = await escrowNextId(grpc, contract);
  for (let id = nextId - 1n; id >= 0n && id >= nextId - lookBack; id--) {
    const e = await escrowRead(grpc, contract, id).catch(() => null);
    if (e && e.buyer === buyer && e.memo === memo) return id;
  }
  return null;
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const sendAnyway = args.includes("--send-anyway");
  const rest = args.filter((a) => a !== "--send-anyway");
  const grpc = createGrpc();
  const contractOf = () => ContractAddress.create(BigInt(env("ESCROW_CONTRACT")), 0n);

  const send = async (keyFile: string, entry: string, param: Buffer, microCcd: bigint) => {
    const r = await escrowSend(grpc, contractOf(), loadAccount(keyFile), entry, param, microCcd, { sendAnyway, log: console.log });
    if (r.dryRunOnly) { console.log("nothing sent (add --send-anyway to put the rejected transaction on-chain as evidence)"); process.exit(1); }
    return r;
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
      const { nextId } = await escrowNextId(grpc, contractOf());
      console.log(`  escrow id ${nextId - 1n} (then: npm run escrow -- release <id>)`);
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
  if (cmd === "buy") {
    // Buy a signal through the escrow: quote from the seller, pay into the contract, release, collect (escrow-sale.ts)
    const asset = (rest[0] ?? "").toUpperCase();
    const gateway = (rest[1] ?? process.env.GATEWAY_URL ?? "https://veriflow-yrhp.onrender.com").replace(/\/$/, "");
    if (!/^[A-Z]{2,10}$/.test(asset)) throw new Error("usage: buy <asset> [gateway url]   e.g. buy BTC");
    const buyer = loadAccount(env("BUYER_KEY_FILE"));
    const qr = await fetch(`${gateway}/escrow-sale/${asset}/quote?buyer=${buyer.address}`);
    const q = await qr.json() as any;
    if (!qr.ok) throw new Error(`no quote (${qr.status} ${q.error}): ${q.message}`);
    const max = BigInt(env("ESCROW_MAX_MICROCCD", "5000000"));
    if (BigInt(q.amount_micro_ccd) > max) throw new Error(`the seller asks ${Number(q.amount_micro_ccd) / 1e6} CCD, above ESCROW_MAX_MICROCCD`);
    if (q.contract !== `<${env("ESCROW_CONTRACT")},0>`) throw new Error(`the seller names escrow ${q.contract}, not ESCROW_CONTRACT=${env("ESCROW_CONTRACT")}; nothing sent`);
    // The contract must run the reviewed module: otherwise "the contract checks the registry" is only a claim
    const mod = ModuleReference.toHexString((await grpc.getInstanceInfo(contractOf())).sourceModule);
    if (mod !== (process.env.EXPECTED_ESCROW_MODULE ?? EXPECTED_MODULE)) throw new Error(`escrow runs module ${mod}, not the reviewed ${EXPECTED_MODULE}; nothing sent`);
    console.log(`quote: ${Number(q.amount_micro_ccd) / 1e6} CCD for agent #${q.token_id} through ${q.contract}, memo ${q.memo}`);
    console.log("1/3 pay (the contract reads CIS-8004 agentOf and records the agent's wallet)…");
    const p = await send(env("BUYER_KEY_FILE"), "pay", encodePay(BigInt(q.token_id), Number(q.minutes), q.memo), BigInt(q.amount_micro_ccd));
    if (!p.ok) throw new Error(`pay failed: ${p.code} ${p.error}`);
    const id = await escrowIdOf(grpc, contractOf(), buyer.address, q.memo);
    if (id === null) throw new Error("paid, but the escrow id could not be read back; find it with: npm run escrow -- status");
    console.log(`  escrow id ${id}\n2/3 release (the contract reads agentOf again and pays the recorded wallet)…`);
    const r = await send(env("BUYER_KEY_FILE"), "release", u64(id), 0n);
    if (!r.ok) throw new Error(`release failed: ${r.code} ${r.error}. The CCD are still held; you can refund: npm run escrow -- refund ${id}`);
    for (const t of r.transfers) console.log(`  paid ${Number(t.microCcd) / 1e6} CCD to ${t.to}`);
    console.log("3/3 collect the signal…");
    for (let i = 0; i < 3; i++) {
      const d = await fetch(`${gateway}/escrow-sale/${asset}/deliver`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ escrow_id: id.toString(), claim_token: q.claim_token }) });
      const body = await d.json() as any;
      if (d.ok) { console.log(JSON.stringify(body, null, 2)); return; }
      console.log(`  ${d.status} ${body.error}: ${body.message ?? body.detail ?? ""}`);
      if (d.status < 500) break;
      await new Promise((ok) => setTimeout(ok, 5000));
    }
    console.log(`not collected yet; try again later (within 24 h): curl -X POST ${gateway}/escrow-sale/${asset}/deliver -H 'content-type: application/json' -d '{"escrow_id":"${id}","claim_token":"<the claim token above>"}'`);
    console.log(`claim token (keep private): ${q.claim_token}`);
    process.exit(1);
  }
  if (cmd === "check") {
    const id = rest[0];
    if (!/^\d+$/.test(id ?? "")) throw new Error("usage: check <token id>");
    const buyer = loadAccount(env("BUYER_KEY_FILE"));
    const r = await escrowWouldAccept(grpc, contractOf(), buyer.accountAddress, BigInt(id));
    console.log(r.ok ? `agent #${id}: the escrow would accept a payment (nothing sent)` : `agent #${id}: the escrow would reject it: ${r.code} ${r.error} (nothing sent)`);
    return;
  }
  if (cmd === "status") {
    const id = rest[0];
    if (id) {
      const e = await escrowRead(grpc, contractOf(), BigInt(id));
      console.log(e ? { ...e, amount: `${Number(e.amountMicroCcd) / 1e6} CCD`, amountMicroCcd: undefined } : `no escrow ${id}`);
    } else {
      const v = await escrowNextId(grpc, contractOf());
      console.log(`escrow <${env("ESCROW_CONTRACT")},0>  registry ${v.registry}  escrows so far ${v.nextId}`);
    }
    return;
  }
  console.log("usage: npm run escrow -- deploy | buy <asset> [gateway url] | pay <token id> <ccd> [minutes] [memo] | release|refund|claim <escrow id> | check <token id> | status [escrow id]  (add --send-anyway to send a call the contract would reject)");
  process.exit(2);
}

if (isMain(import.meta.url)) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
