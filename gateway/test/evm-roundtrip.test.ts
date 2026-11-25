/**
 * 跨鏈付款整條路（離線）：賣方用 x402 產生 Base Sepolia USDC 的付款條件 → 買方用官方 EVM client 簽 →
 * 賣方從簽名還原付款人並對回 Concordium 帳號。facilitator 用假的，只回 /supported。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { x402ResourceServer } from "@x402/core/server";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme as EvmServer } from "@x402/evm/exact/server";
import { ExactEvmScheme as EvmClient } from "@x402/evm/exact/client";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { concordiumAccountOfEvmPayment } from "../src/evm-payer.ts";

const OWNER = "4Vf4qUg5jWyAJXJ3mR3RHvfu8YXjiNT5asveQFF52FgkjMQ16r";
const NET = "eip155:84532" as const;

test("server requirements → official EVM client payment → Concordium account via CIS-8", async () => {
  const fakeFacilitator = {
    getSupported: async () => ({ kinds: [{ x402Version: 2, scheme: "exact", network: NET }], extensions: [], signers: {} }),
    verify: async () => { throw new Error("not used"); },
    settle: async () => { throw new Error("not used"); },
  };
  const server = new x402ResourceServer(fakeFacilitator as never).register(NET, new EvmServer());
  await server.initialize();
  const [req] = await server.buildPaymentRequirements({ scheme: "exact", network: NET, payTo: "0xdd315C4383bC9aedbE18E7bD954be3718a2F8746", price: "$0.01", extra: { cis8: { publicKey: "0x04" } } } as never);
  assert.equal(req.amount, "10000");
  assert.equal(req.asset.toLowerCase(), "0x036cbd53842c5426634e7929541ec2318f3dcf7e");
  assert.equal((req.extra as { cis8?: unknown }).cis8 !== undefined, true, "our extra survives");

  const acct = privateKeyToAccount(generatePrivateKey());
  const client = x402Client.fromConfig({
    schemes: [{ network: NET, client: new EvmClient(acct) }],
    spendControls: { allowedAssets: [{ network: NET, asset: "USDC", maxAmountPerPayment: "20000" }] },
  });
  const payment = await client.createPaymentPayload({ x402Version: 2, resource: { url: "https://x/signal/BTC", description: "", mimeType: "" }, accepts: [req] } as never);
  const r = await concordiumAccountOfEvmPayment(payment.payload, req as never, async (k) =>
    k.publicKey.toLowerCase() === acct.publicKey.toLowerCase() ? { owner: OWNER, status: "Active", proofScheme: "ethereum-personal-sign", key: k } : null,
  );
  assert.deepEqual(r, { ok: true, from: acct.address, account: OWNER });
});
