import { test } from "node:test";
import assert from "node:assert/strict";
import { AccountAddress, CcdAmount } from "@concordium/web-sdk";
import { transferOf } from "../src/settle-recovery.ts";

const A = "4Vf4qUg5jWyAJXJ3mR3RHvfu8YXjiNT5asveQFF52FgkjMQ16r";
const B = "3WSAJwTZqVRypnGMkUjW28QDES8h1FUBoCwrzQ1rdN35NGavf8";

test("reads sender, receiver and amount from SDK-typed and plain summaries", () => {
  const typed = { sender: AccountAddress.fromBase58(A), transactionType: "transfer", transfer: { to: AccountAddress.fromBase58(B), amount: CcdAmount.fromMicroCcd(1_000_000n) } };
  assert.deepEqual(transferOf(typed), { sender: A, to: B, amount: 1_000_000n });
  const plain = { sender: A, transfer: { to: B, amount: "1000000" } };
  assert.deepEqual(transferOf(plain), { sender: A, to: B, amount: 1_000_000n });
  assert.equal(transferOf({ sender: A }).amount, undefined);
});

// ---- Base USDC: confirm from the receipt that the money arrived ----
import { encodeEventTopics, encodeAbiParameters, erc20Abi } from "viem";
import { evmTransferMatches, paidOnEvm } from "../src/settle-recovery.ts";

const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const FROM = "0xAc0220Eb4dd8289d16D91339126b475C0ab5aCb8";
const PAYTO = "0xdd315C4383bC9aedbE18E7bD954be3718a2F8746";
const transferLog = (o: { address?: string; from?: string; to?: string; value?: bigint } = {}) => ({
  address: (o.address ?? USDC) as `0x${string}`,
  topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: (o.from ?? FROM) as `0x${string}`, to: (o.to ?? PAYTO) as `0x${string}` } }) as [`0x${string}`, ...`0x${string}`[]],
  data: encodeAbiParameters([{ type: "uint256" }], [o.value ?? 10000n]),
  blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, removed: false,
}) as never;
const want = { from: FROM, payTo: PAYTO, amount: "10000", asset: USDC };

test("EVM recovery: a successful receipt with the exact USDC Transfer counts as paid", async () => {
  assert.deepEqual(evmTransferMatches({ status: "success", logs: [transferLog()] }, want), { ok: true });
  const h = "0x" + "ab".repeat(32);
  assert.deepEqual(await paidOnEvm(h, want, async () => ({ status: "success", logs: [transferLog()] })), { ok: true });
});

test("EVM recovery refuses reverted, wrong token, wrong payer, wrong payee, wrong amount, bad hash, RPC errors", async () => {
  for (const [why, r] of [
    ["reverted", { status: "reverted", logs: [transferLog()] }],
    ["other token", { status: "success", logs: [transferLog({ address: "0x0000000000000000000000000000000000000001" })] }],
    ["other payer", { status: "success", logs: [transferLog({ from: PAYTO })] }],
    ["other payee", { status: "success", logs: [transferLog({ to: FROM })] }],
    ["other amount", { status: "success", logs: [transferLog({ value: 9999n })] }],
    ["no logs", { status: "success", logs: [] }],
  ] as const) assert.equal(evmTransferMatches(r as never, want).ok, false, why);
  assert.equal((await paidOnEvm("abc", want, async () => { throw new Error("unused"); })).ok, false);
  assert.equal((await paidOnEvm("0x" + "ab".repeat(32), want, async () => { throw new Error("timeout"); })).ok, false);
});

import { matchesPayment, pltTransfersOf } from "../src/settle-recovery.ts";
import { TokenAmount, TokenHolder, TokenId } from "@concordium/web-sdk/plt";

// Shaped like the node's summary of tx 99310359…: 1.000000 hh-VFUSD from 19528 to 19394, a facilitator that reported "transaction not found"
const pltSummary = (o: { token?: string; from?: string; to?: string; value?: bigint; type?: string } = {}) => ({
  transactionType: o.type ?? "tokenUpdate",
  events: [
    { tag: "TokenTransfer", tokenId: TokenId.fromString(o.token ?? "hh-VFUSD"), from: TokenHolder.fromAccountAddress(AccountAddress.fromBase58(o.from ?? A)),
      to: TokenHolder.fromAccountAddress(AccountAddress.fromBase58(o.to ?? B)), amount: TokenAmount.create(o.value ?? 1_000_000n, 6) },
  ],
});

test("PLT recovery: a finalized token transfer of exactly this token and amount, payer → payTo, counts as paid", () => {
  assert.deepEqual(pltTransfersOf(pltSummary()).map((t) => [t.tokenId, t.from, t.to, t.amount]), [["hh-VFUSD", A, B, 1_000_000n]]);
  assert.deepEqual(matchesPayment(pltSummary(), A, B, "1000000", "hh-VFUSD"), { ok: true });
});

test("PLT recovery refuses another token, amount, payer, payee, or a non-token transaction", () => {
  for (const [s, why] of [
    [pltSummary({ token: "EUDemo" }), "token"],
    [pltSummary({ value: 999_999n }), "amount"],
    [pltSummary({ from: B }), "payer"],
    [pltSummary({ to: A }), "payee"],
    [pltSummary({ type: "transfer" }), "type"],
  ] as const) assert.equal(matchesPayment(s, A, B, "1000000", "hh-VFUSD").ok, false, why);
  // and CCD still works as before
  assert.equal(matchesPayment({ sender: AccountAddress.fromBase58(A), transfer: { to: AccountAddress.fromBase58(B), amount: CcdAmount.fromMicroCcd(1_000_000n) } }, A, B, "1000000", "CCD").ok, true);
});
