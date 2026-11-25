# VeriFlow in one page

**A paid AI agent that both sides can check on Concordium before any money moves.** A buyer agent reads the seller from the Agent Registry before it signs. The seller checks a zero-knowledge eligibility proof, and the buyer's own registered agent, before it settles. Every call sold is committed on-chain before its outcome, one per asset and day, under a scoring rule registered before the first call. Payment works in CCD on Concordium, or in USDC on Base with both wallets bound to Concordium accounts.

Live on testnet: <https://veriflow-yrhp.onrender.com>. Code (MIT): this repo.

## The problem

Agents will pay other agents per call. Today an x402 client pays whatever `payTo` a server returns, the server cannot tell who is buying, and a seller of signals can quietly edit or drop its bad calls. VeriFlow shows all three closed with Concordium primitives, end to end, with transactions anyone can open.

## What Concordium does here

| Check | Concordium piece | Proof on-chain |
|---|---|---|
| **Buyer → seller:** the agent being paid is identity-verified, Active, its card unchanged, and `payTo` is its own wallet | CIS-8004 Agent Registry `<12802,0>`, agent #1313, Verified by Concordium badge; read from a node, not a hosted API | [`setAgentWallet` `8238b866…`](https://ccdexplorer.io/testnet/transaction/8238b866de05398d95fd66be64a74b1f0e86279cd2b748838ebaa5fd4e44e33b) |
| **Seller → buyer:** 18+ and not resident in a restricted country, nothing else revealed; re-checked at every payment | Verify & Access V1 (request and audit anchored) | [VRA `edc30fac…`](https://ccdexplorer.io/testnet/transaction/edc30fac188ba167b37e8f7338ce691a0f00932303201230576056e8a103a5d6), [VAA `c40957b4…`](https://ccdexplorer.io/testnet/transaction/c40957b4731064f10103ae7272509cd26a1863ae75746e74f53d8578b4a71e90) |
| **Seller → buyer agent:** the payer is the `agentWallet` of the agent it names, so an agent id cannot be borrowed | CIS-8004, buyer agent #1478 | [`setAgentWallet` `e2487e43…`](https://ccdexplorer.io/testnet/transaction/e2487e43d130ac6f5af8ba541978a779e4490f7741086b2115a3f0e3b1484819) |
| **Cross-chain:** a USDC payment on Base is tied to Concordium accounts on both ends | CIS-8 External Key Registry `<12801,0>`; the payer's key is recovered from its EIP-3009 signature | Seller key [`64746743…`](https://ccdexplorer.io/testnet/transaction/64746743a948d0d9dbbc0fafbcb8d9c5ee143fb8dbcf210cb6ebbe50627e59ce), buyer key [`21c76e95…`](https://ccdexplorer.io/testnet/transaction/21c76e955cc356c73e2eb3763b8c9841a01dbb1dd44f08f22b71d20da1162a5b), payment [`0xe48c3357…`](https://sepolia.basescan.org/tx/0xe48c3357d84601a51ab4caf6db73274b1d57ef797c21c9f54f80f02c875cbc44) |
| **What was sold, and when:** one call per asset and day, accepted only in the day after the close, revealed after 7 days, label checked by the contract | Our Rust contract v2 `<13115,0>`; cold owner, separate committer | [committer appointed `6e3eb548…`](https://ccdexplorer.io/testnet/transaction/6e3eb5483acbcdbf87717649b0941812513220c52b0623cc652c80678dc7668f) |
| **Scoring fixed in advance** | Rule file hashes registered on-chain before the first commit; a public workflow re-checks them on every run | [`ecadec1b…`](https://ccdexplorer.io/testnet/transaction/ecadec1b75cd764a2f87c512787cb3e5422148852760046978e2e4324d8b3271) |

Payments use x402 v2 (`@x402/concordium`), settled by Concordium's hosted testnet facilitator; Base payments by the public x402 facilitator.

## Check it yourself

- **2 minutes, no wallet:** [TRY_IT.md, Path A](TRY_IT.md#path-a-check-a-bought-call-2-minutes). Hash a bought call, find it on-chain, recompute it from Binance, confirm the scoring rule predates it.
- **See a refusal:** name someone else's agent (`BUYER_AGENT_TOKEN_ID=1313 npm run buyer -- BTC`): `402 buyer_agent_check_failed:wallet_mismatch`, nothing charged.
- **From Claude Desktop:** the MCP server's `check_seller`, `get_signal` and `verify_signal` tools run the same checks ([README, MCP server](README.md#mcp-server--let-any-agent-buy-and-verify)).

## Real purchases

- **CCD, two agents checking each other** (2026-11-24): #1478 paid #1313 [`515226b5…`](https://ccdexplorer.io/testnet/transaction/515226b587ccb056f3e1c406fe1a85e12382a6a19c61345ef41c821395289b88). The call had been committed earlier, in [`d9527398…`](https://ccdexplorer.io/testnet/transaction/d952739813664933795fc43b5d2b4a99a5b0f3455472bad28349628a51f9bd03).
- **USDC on Base, CIS-8 on both sides** (2026-11-25): [`0xe48c3357…`](https://sepolia.basescan.org/tx/0xe48c3357d84601a51ab4caf6db73274b1d57ef797c21c9f54f80f02c875cbc44). The call had been committed earlier, in [`af3fc90c…`](https://ccdexplorer.io/testnet/transaction/af3fc90c65a4deaa9153431018d0ff083a15705f50181626855fa084ffe14ed8).

## Built to fail closed

- A node error, an unreachable registry, a changed card or a revoked binding all stop the payment before it settles.
- The buyer's checks run in a client hook, so a failing seller is never signed for.
- When the hosted facilitator reports a failure for a transfer that did finalize, the gateway reads the transaction from a node. It delivers only on an exact match of payer, `payTo` and amount.
- Details: [THREAT_MODEL.md](docs/THREAT_MODEL.md), [GO_LIVE.md](docs/GO_LIVE.md).

## What it does not claim

- The signal is a public 30-day momentum rule with no edge.
- The product is the accountability around it, which a seller with a private model can reuse.
- Everything runs on testnet, with testnet identity providers.
- So far, the only buyers are our own agents.
