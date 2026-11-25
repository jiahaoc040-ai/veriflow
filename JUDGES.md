# VeriFlow in one page

**A paid AI agent that both sides can check on Concordium before any money moves.** A buyer agent reads the seller from the Agent Registry before it signs. The seller checks a zero-knowledge eligibility proof, and the buyer's own registered agent, before it settles. Every call sold is committed on-chain within a day of the close it is computed from, one per asset and day, before the sale and long before the 7-day outcome it is scored on, under a scoring rule registered before the first call. Payment works in CCD on Concordium, or in USDC on Base with both wallets bound to Concordium accounts.

Live on testnet: <https://veriflow-yrhp.onrender.com>. Code (MIT): this repo.

## The problem

Agents will pay other agents per call. Today an x402 client pays whatever `payTo` a server returns, the server cannot tell who is buying, and a seller of signals can quietly edit or drop its bad calls. VeriFlow shows all three closed with Concordium primitives, end to end, with transactions anyone can open.

## What Concordium does here

| Check | Concordium piece | Proof on-chain |
|---|---|---|
| **Buyer → seller:** the agent being paid is identity-verified, Active, its card unchanged, and the CCD `payTo` is its own `agentWallet` `3WSA…` (for USDC, see the cross-chain row) | CIS-8004 Agent Registry `<12802,0>`, agent #1313, Verified by Concordium badge; read from a node, not a hosted API | [`setAgentWallet` `8238b866…`](https://ccdexplorer.io/testnet/transaction/8238b866de05398d95fd66be64a74b1f0e86279cd2b748838ebaa5fd4e44e33b) |
| **Seller → buyer:** 18+ and not resident in a restricted country, nothing else revealed; re-checked at every payment | Verify & Access V1 (request and audit anchored by VeriFlow's operator; the anchors carry hashes only, so the age and country claim is not readable on-chain: re-running the check needs the stored proof, which the gateway does at every payment) | [VRA `edc30fac…`](https://ccdexplorer.io/testnet/transaction/edc30fac188ba167b37e8f7338ce691a0f00932303201230576056e8a103a5d6), [VAA `c40957b4…`](https://ccdexplorer.io/testnet/transaction/c40957b4731064f10103ae7272509cd26a1863ae75746e74f53d8578b4a71e90) |
| **Seller → buyer agent:** the payer is the `agentWallet` of the agent it names, so an agent id cannot be borrowed | CIS-8004, buyer agent #1478 | [`setAgentWallet` `e2487e43…`](https://ccdexplorer.io/testnet/transaction/e2487e43d130ac6f5af8ba541978a779e4490f7741086b2115a3f0e3b1484819) |
| **Cross-chain:** a USDC payment on Base is tied to Concordium accounts on both ends | CIS-8 External Key Registry `<12801,0>`; the payer's key is recovered from its EIP-3009 signature | Seller key [`64746743…`](https://ccdexplorer.io/testnet/transaction/64746743a948d0d9dbbc0fafbcb8d9c5ee143fb8dbcf210cb6ebbe50627e59ce), buyer key [`21c76e95…`](https://ccdexplorer.io/testnet/transaction/21c76e955cc356c73e2eb3763b8c9841a01dbb1dd44f08f22b71d20da1162a5b), payment [`0xe48c3357…`](https://sepolia.basescan.org/tx/0xe48c3357d84601a51ab4caf6db73274b1d57ef797c21c9f54f80f02c875cbc44) |
| **What was sold, and when:** one call per asset and day, accepted only in the day after the close, revealed after 7 days; on reveal the contract checks the text hashes to the commit and its label agrees with its own momentum number (whether that number matches Binance is checked off-chain by the scoring workflow) | Our Rust contract v2 `<13115,0>`; cold owner, separate committer. Rule-breaking commits tried on purpose and rejected on-chain: [duplicate `29ef60c5…`](https://ccdexplorer.io/testnet/transaction/29ef60c50e0a1b1a8103c427c218f3f589b9f9b078982008b983b4a9c1e1c5f2), [late `ce062332…`](https://ccdexplorer.io/testnet/transaction/ce0623322833d6d0d6d5a2891ff7f65ca46b18b45f491483850f4419136047c6) | [committer appointed `6e3eb548…`](https://ccdexplorer.io/testnet/transaction/6e3eb5483acbcdbf87717649b0941812513220c52b0623cc652c80678dc7668f) |
| **Scoring fixed in advance** | Rule file hashes registered on-chain before the committer existed (07:06 vs 07:33 UTC, 2026-11-22), so before any commit; a public workflow re-checks the hashes and that ordering on every run | [`ecadec1b…`](https://ccdexplorer.io/testnet/transaction/ecadec1b75cd764a2f87c512787cb3e5422148852760046978e2e4324d8b3271) |

Payments use x402 v2 (`@x402/concordium`). Since 2026-11-24 CCD payments settle through Concordium's hosted testnet facilitator (API key issued to the team; fee payer account 19003, named in the live 402's `extra.feePayer`); earlier purchases, including `515226b5…` and `935bc182…`, were settled by VeriFlow's own facilitator, which sponsored the fee from account 19719. Base payments settle through the public x402 facilitator.

## The same checks across mainnet

We ran the buyer's pre-payment checks, read-only, over the whole **mainnet** Agent Registry `<10082,0>` (agents 1–5403, read from a Concordium node on 2026-11-25; [report](https://github.com/jiahaoc040-ai/veriflow/tree/score-reports/census/mainnet), [code](gateway/src/census.ts)):

- **About 1 in 4 Active agents (23.5%) fail the checks a buyer can make before paying.** 4,124 of 5,393 (76.5%) have an on-chain `agentWallet` and an https Agent Card whose SHA-256 equals the on-chain hash. 1,114 have no wallet bound, 665 cards do not load, 56 cards no longer match their pinned hash. Passing is a low bar: all but one of the bound wallets are the owner's own account.
- **Cross-chain identity is already common.** 2,600 Active agents (48%) link an external key through `external_reference`; 480 of those are under a Concordium mainnet namespace, so about 2,120 (39%) are keys on other chains (Ethereum, NEAR, Solana, Fetch.ai, …). Every one we could read is Active in CIS-8 under the agent's own owner.
- **Paid endpoints are rare.** 322 cards mention x402; one live x402 endpoint is reachable from a card URL (x402 Doctor, #5120, paid on EVM chains, its Base key bound in CIS-8).

What it does not check: the hosted badge service, endpoints not linked from the card. One agent (#839) could not be read: the public node rate-limited the request (HTTP 429) after retries; later runs record the reason in the report. Testnet: [same report](https://github.com/jiahaoc040-ai/veriflow/tree/score-reports/census/testnet).

## Check it yourself

- **About 10 minutes, no wallet:** [TRY_IT.md, Path A](TRY_IT.md#path-a-check-a-bought-call-about-10-minutes). Hash a bought call, find it on-chain, recompute it from Binance, confirm the scoring rule predates it.
- **See a refusal, no wallet needed:** `cd gateway && npm ci && npm run impostor` starts a local fake seller that copies #1313's card, badge and 402 but swaps `payTo`; the buyer passes 4 checks, fails the 5th, and refuses before signing. Transcripts of this and the other refusals: [docs/EVIDENCE.md](docs/EVIDENCE.md).
- **From Claude Desktop:** the MCP server's `check_seller`, `get_signal` and `verify_signal` tools run the same checks ([README, MCP server](README.md#mcp-server--let-any-agent-buy-and-verify)).

## Real purchases

- **First buyer outside the team** (2026-11-25): a friend of the developer, new to Concordium, followed TRY_IT Path B on Windows with their own testnet identity, wallet and key (never shared). Eligibility proof [VRA `e1011651…`](https://ccdexplorer.io/testnet/transaction/e10116517edc9f6259449f6498c9747313f5324c6ea2756403ce0944a2880c06) / [VAA `70df5beb…`](https://ccdexplorer.io/testnet/transaction/70df5beb5d318803a340dc60457225b6417393bfdc970b6d892a6c063a9e6795); paid 1 CCD from account 19836 to #1313's wallet 19394, fee sponsored by Concordium's facilitator (19003): [`1f904fb3…`](https://ccdexplorer.io/testnet/transaction/1f904fb3fbeac7c77891d535c77aec585059447d438a3bd6a9953b8b5b3b4af1). They then re-checked the call against the chain and Binance. Their report found two bugs (a front-end error after a successful proof; payments failing when the buyer's clock ran 2 minutes fast) and nine unclear steps; all were fixed the same evening.
- **CCD, two agents checking each other** (2026-11-24): #1478 paid #1313 [`515226b5…`](https://ccdexplorer.io/testnet/transaction/515226b587ccb056f3e1c406fe1a85e12382a6a19c61345ef41c821395289b88). The call had been committed earlier, in [`d9527398…`](https://ccdexplorer.io/testnet/transaction/d952739813664933795fc43b5d2b4a99a5b0f3455472bad28349628a51f9bd03).
- **USDC on Base, CIS-8 on both sides** (2026-11-25): [`0xe48c3357…`](https://sepolia.basescan.org/tx/0xe48c3357d84601a51ab4caf6db73274b1d57ef797c21c9f54f80f02c875cbc44). The call had been committed earlier, in [`af3fc90c…`](https://ccdexplorer.io/testnet/transaction/af3fc90c65a4deaa9153431018d0ff083a15705f50181626855fa084ffe14ed8).

## Built to fail closed

- A node error, an unreachable registry, a changed card or a revoked binding all stop the payment before it settles.
- The buyer's checks run in a client hook, so a failing seller is never signed for.
- When a facilitator reports a failure for a transfer that did go through, the gateway reads the transaction itself: CCD from a Concordium node, USDC from the Base receipt. It delivers only on an exact match of payer, `payTo` and amount.
- Details: [THREAT_MODEL.md](docs/THREAT_MODEL.md), [GO_LIVE.md](docs/GO_LIVE.md).

## What it does not claim

- The signal is a public 30-day momentum rule with no edge.
- The product is the accountability around it, which a seller with a private model can reuse.
- Everything runs on testnet, with testnet identity providers.
- One buyer outside the team so far, a friend of the developer; every other purchase was by our own agents.
