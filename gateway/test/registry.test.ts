import { test } from "node:test";
import assert from "node:assert/strict";
import { mintedTokenId } from "../src/registry.ts";

test("token id from a real testnet CIS-8004 Registered event (token 1263)", () => {
  const registered = "f008ef04000000000000eab0d16830f54c9b5b32f9c0088d084471540ac25cf63600e812afd60bf265fb01";
  assert.equal(mintedTokenId(["ff00", registered]), "1263");
});

test("token id from a CIS-2 Mint event; ignores unrelated events", () => {
  assert.equal(mintedTokenId(["fe080500000000000000" + "01" + "00".repeat(33)]), "5");
  assert.equal(mintedTokenId(["fb01", "ab"]), undefined);
});

test("agent-card.json still matches the hash pinned on-chain for agent #1313", async () => {
  const { readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const bytes = readFileSync(new URL("../../agent-card.json", import.meta.url));
  const sha = createHash("sha256").update(bytes).digest("hex");
  assert.equal(
    sha,
    "bfbe4573465a8118706db384d4d636f62aaa32cf2ea33952ba8a21c2d723fd6f",
    "agent-card.json changed: re-pin it with `npm run registry -- set-uri 1313`, then update this hash",
  );
});

test("setAgentWallet authorization: only sign the exact message we mean to authorize", async () => {
  const { checkSetWalletMessage, TESTNET_GENESIS } = await import("../src/registry.ts");
  const { AccountAddress } = await import("@concordium/web-sdk");
  const OWNER = "4dNMXmNKa2i5hvABfbRJ6NebGopaWSPNmMrbvroSzgJF5wjUNt";
  const WALLET = "3WSAJwTZqVRypnGMkUjW28QDES8h1FUBoCwrzQ1rdN35NGavf8";
  const u64 = (v: bigint | number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
  const deadlineMs = 1_795_000_000_000;
  const msg = (o: { token?: number; wallet?: string; genesis?: string; deadline?: number; index?: number } = {}) =>
    Buffer.concat([
      Buffer.from("CIS-8004/v1/setAgentWallet"),
      u64(o.token ?? 1313),
      Buffer.from(AccountAddress.fromBase58(OWNER).decodedAddress),
      Buffer.from(AccountAddress.fromBase58(o.wallet ?? WALLET).decodedAddress),
      u64(0),
      u64(o.deadline ?? deadlineMs),
      u64(o.index ?? 12802),
      u64(0),
      Buffer.from(o.genesis ?? TESTNET_GENESIS, "hex"),
    ]);
  const want = { tokenId: "1313", owner: OWNER, wallet: WALLET, deadlineMs, contract: { index: 12802n, subindex: 0n }, genesis: TESTNET_GENESIS };
  assert.equal(msg().length, 162);
  assert.equal(checkSetWalletMessage(msg(), want).nonce, 0n);
  // 官方服務回傳的前 40 個位元組（agent #1313）與我們的版面一致
  assert.ok(msg().toString("hex").startsWith("4349532d383030342f76312f7365744167656e7457616c6c65742105000000000000ddaaaad8411e"));
  assert.throws(() => checkSetWalletMessage(msg({ token: 1252 }), want), /token id/);
  assert.throws(() => checkSetWalletMessage(msg({ wallet: "2xBpaHottqhwFZURMZW4uZduQvpxNDSy46iXMYs9kceNGaPpZX" }), want), /新錢包/);
  assert.throws(() => checkSetWalletMessage(msg({ genesis: "00".repeat(32) }), want), /genesis/);
  assert.throws(() => checkSetWalletMessage(msg({ deadline: deadlineMs + 1 }), want), /期限/);
  assert.throws(() => checkSetWalletMessage(msg({ index: 10082 }), want), /合約/);
  assert.throws(() => checkSetWalletMessage(msg().subarray(0, 161), want), /162/);
});
