# Path to production: testnet → mainnet → real users

## What runs today (testnet)

Everything below is live on Concordium testnet at <https://veriflow-yrhp.onrender.com>, with transactions anyone can open. Some parts are testnet stand-ins, listed after.

- **x402 v2 payments.** 1 CCD per call, paid to agent #1313's on-chain `agentWallet`. The 402 names the agent (`concordium-agent` extension), and our buyer refuses to sign unless the registry, read from a node, agrees on the wallet.
- **Verify & Access V1 eligibility.** A zero-knowledge proof of age ≥ 18 and residence outside a restricted list. The request (VRA) and audit record (VAA) are anchored on-chain, and the proof is re-checked against the live policy at settlement.
- **Agent #1313 in the CIS-8004 Agent Registry `<12802,0>`.** Verified by Concordium badge, Agent Card hash pinned on-chain, payout wallet bound on-chain. The owner account is kept offline.
- **Contract v2 `<13115,0>`.** One call per asset and day, accepted only in the day after the close, revealed after 7 days, label checked against momentum on reveal. The owner key is offline. The server holds a separate committer key (account 19719), which also pays for anchoring (daily calls, eligibility records) and holds a few hundred test CCD. Buyer fees have been paid by Concordium's hosted facilitator since 2026-11-24; before that, by our own facilitator (19527 until 2026-11-22, then 19719).
- **Scoring rule anchored before the first call** and re-run by a public GitHub workflow four times a day.
- **Cross-chain payment in USDC on Base Sepolia.** Optional second price (`SELLER_EVM_PUBLIC_KEY`, `EVM_PRICE_USD`), settled by the public x402 facilitator. Seller payout key and buyer paying key are bound to Concordium accounts in the CIS-8 External Key Registry `<12801,0>`; the buyer checks the seller's binding before signing and the seller maps the payer back to a Concordium account (eligibility and buyer-agent checks apply to it). First purchase [`0xe48c3357…`](https://base-sepolia.blockscout.com/tx/0xe48c3357d84601a51ab4caf6db73274b1d57ef797c21c9f54f80f02c875cbc44). On mainnet the EVM network becomes Base (`eip155:8453`) and the CIS-8 registry `<10081,0>`, both from `network.ts`.
- **MCP server** that Claude Desktop uses to check the seller, pay, and verify the call on-chain.

**Testnet stand-ins:**
- Identities come from testnet identity providers.
- Since 2026-11-24, payments settle through Concordium's hosted testnet x402 facilitator (API key issued to the team), which also pays buyers' fees ([`f0ec0ca6…`](https://ccdexplorer.io/testnet/transaction/f0ec0ca61ce29add3166f10a35e8814108d9da5e730c4256c3f7e6d635d4ed14), sponsor 19003). On testnet it reports `finalization_failed: transaction not found` for transfers that do finalize, so the gateway reads the reported transaction from a node and delivers only if it is finalized, sent by the payer, and pays exactly the price to `payTo` (`gateway/src/settle-recovery.ts`). Without the key, the gateway falls back to its own facilitator.
- Eligibility is cached in our database after the proof; settlement re-checks the stored proof and its on-chain anchors, but buyers still rely on our server to run that check.
- Two buyer accounts outside the team so far: 19760, a tester from the hackathon Discord, and 19836, a friend of the developer (own testnet identity and wallet: [`1f904fb3…`](https://ccdexplorer.io/testnet/transaction/1f904fb3fbeac7c77891d535c77aec585059447d438a3bd6a9953b8b5b3b4af1)); every other purchase was ours or a demo button.

## Already usable on mainnet

The buyer-side guard needs no registration and no keys of ours: it is published on npm as [`concordium-x402-guard`](https://www.npmjs.com/package/concordium-x402-guard) and runs against mainnet today (`concordiumGuardDeps({ network: "mainnet" })`). On 2026-11-26 it checked x402 Doctor (agent #5120) on mainnet, including its Base payout bound in CIS-8 ([output](evidence/guard-2026-11-26-checks.txt)). The payout rule also exists as a contract: the escrow `<13171,0>` (`contract-escrow/`, verifiable build) reads the registry itself and pays only the `agentWallet` it recorded at payment, while the registry still names it for an Active agent; for mainnet it is initialised with the mainnet registry `<10082,0>`, nothing else changes. The seller side is packaged the same way, as [`concordium-x402-seller`](../packages/concordium-x402-seller) (Verify & Access re-check at every payment, buyer-agent check, settlement recovery, once-only delivery), with `network: "mainnet"` supported; it needs the seller's own anchoring account for Verify & Access. What follows is about our own seller.

## What changes for mainnet

The network is one setting, `CONCORDIUM_NETWORK` (`testnet` or `mainnet`), in `gateway/src/network.ts`. It drives the x402 CAIP-2 network, the Verify & Access DID network, the CIS-8004 registry contract the buyer reads (testnet `<12802,0>`; mainnet `<10082,0>`, the address [Concordium publishes](https://docs.concordium.com/en/mainnet/technical-reference/agent-registry/index.html)) and the explorer links. A build test fails if the testnet or mainnet network strings, explorer URLs or CAIP-2 constants, or either registry index, appear in code (not comments) of any other file in `gateway/src`. Three files are exempt: `network.ts` itself, and the two scoring scripts, which name the testnet deployment on purpose (`score-v2.ts` is frozen by its on-chain hash; `score.ts` scores only the retired v1 contract). Mainnet gets its own anchored rule (step 2 below). Before it accepts connections, the gateway asks its node for the chain's genesis and exits if it belongs to the other network; it repeats this every minute. It tries up to three times (each gRPC call times out after 20 seconds). If all three fail without an answer, it starts but takes no payment (every 402 payment is refused with `node_unconfirmed`) until a later check succeeds, and it exits at the first later check that sees the other network. A node that switched chains after a passing check is caught within about a minute. The embedded facilitator listens on 127.0.0.1 only, before this check.

The setting is not the whole job. Mainnet also needs:

1. **A new agent.** Register in the mainnet Agent Registry `<10082,0>` from a mainnet identity, get the badge, and bind a mainnet `agentWallet`. The agent id will differ from #1313; the buyer reads it from the 402 and the registry, not from code.
2. **A new contract and a new anchored rule.** Deploy contract v2 to mainnet after an external review, then anchor a scoring rule that names the mainnet contract and module before its first commit, exactly as on testnet.
3. **Key handling.** Owner key on a hardware wallet. Three server-side roles, three accounts: the committer (commits only), the anchoring account (eligibility records), and, only if we run our own facilitator, a fee sponsor. Each holds a few days of fees and is topped up by hand. The `watch` workflow already compares the agent record and the contract roles with the expected values every six hours and fails on any change; a failed scheduled run emails the repository owner (GitHub's default), and that is the alert.
4. **Settlement.** On testnet, Concordium's hosted facilitator settles and sponsors fees (API key on request). We have not seen a mainnet equivalent documented, and have asked. If there is none, plan A is the facilitator already in this repo (`gateway/src/facilitator.ts`, `EMBED_FACILITATOR=1`), which settled every payment before 2026-11-24. The differences from the hosted one: our account pays buyers' fees, it listens on 127.0.0.1 only, and it reads finalization from our node, so the "transaction not found" mis-report seen on testnet does not arise (the on-chain recovery stays on regardless).
5. **Eligibility on mainnet.** Verify & Access is documented for mainnet with three identity providers (Digital Trust Solutions, Notabene, Global FinReg: [Concordium docs](https://docs.concordium.com/en/mainnet/how-to/concordium-id/verify-and-access/select-identity-provider.html)). The gateway reads the identity provider list from its node, so it takes whatever mainnet lists; the policy (age, countries) does not change.
6. **Pricing.** 1 CCD is not a stable price. The x402 Concordium scheme we already use (`@x402/concordium`) settles PLT tokens such as EURR by setting `price.asset` to the token id ([package README](https://github.com/x402-foundation/x402/blob/main/typescript/packages/mechanisms/concordium/README.md)). The scheme needs no change, and this repo already does it on testnet: `PLT_PRICE=EUDemo:1000000,hh-VFUSD:1000000` adds 1 `EUDemo` (Concordium's allow-listed test euro) and 1 `hh-VFUSD` beside CCD, and a buyer pays with `BUYER_PAY_ASSET=EUDemo` ([payment `2faa32b1…`](https://ccdexplorer.io/testnet/transaction/2faa32b102cb68365f64feef63245f2ef625aeb4a94a7018855ad5aee93866ab)). An allow-listed token also needs buyer and seller on its list, which the seller should check before quoting that price. On mainnet the token becomes an issued stablecoin, and which one is open: StablR's EURR and USDR, the first PLT stablecoins, froze operations after an exploit in May 2026 that minted unbacked tokens ([The Block](https://www.theblock.co/news/regulation/2026-05-24-stablrs-eurr-and-usdr-depeg-after-attacker-mints-13-5-million-in-unbacked-tokens-through-multisig-exploit-402429)), so we will price in the first euro PLT with real liquidity and keep CCD until then. Price above the sponsored fee: with our own facilitator each sale costs us about Ͼ4–5 in fees, so 1 CCD would sell at a loss.
7. **Base mainnet.** The public x402.org facilitator that settles Base Sepolia is not for mainnet. Base USDC on mainnet needs a production facilitator (for example Coinbase CDP, with an API key) or settlement by our own facilitator; `FACILITATOR_EVM_URL` is the setting.
8. **Our own node.** The gateway reads finality, the registry and the genesis from a node it trusts. Concordium does not run a public hosted gRPC node for production, so mainnet means our own node (at least 16 GB of memory and 1 TB of NVMe, a few days to sync) or a provider found through Concordium; the $7 Render instance cannot run one.
9. **Rebuild contract v2 as a verifiable build.** The testnet v2 module shows "Unverifiable" on CCDExplorer because it was built before we used Concordium's verifiable-build image; the escrow already is Verified. The mainnet module is built with `cargo concordium build --verifiable` in CI, and the rule anchored for mainnet names that module's hash.
10. **Legal review** of selling a market signal to anonymous agents, before the first mainnet sale. The restricted-country list is one configuration value.

## Who the users are

1. **Trading and treasury agents** that today take signals from channels and dashboards with histories nobody can check. Here they can check the seller and every past call on-chain before paying, per call, with no account.
2. **Agent platforms whose agents have verified humans behind them.** VeriFlow is a drop-in MCP tool for them.
3. **Other signal sellers.** The contract and scoring workflow are a reusable pattern (MIT, see `LICENSE`): commit before the outcome, one call per day, a rule fixed in advance. A seller with a private model gets a record buyers can trust without trusting the seller.

The signal itself is a public 30-day momentum rule and carries no edge. The product being demonstrated is the accountability around it.

## Milestones

| # | When | What | Done when |
|---|---|---|---|
| M0 | Dec 2026 | The testnet system above, with the first reveals (from 2026-11-29) and the first published score (after 2026-11-30). | Reveal transactions on CCDExplorer; a green `score-v2` run with numbers |
| M1 | Q1 2027 | Contract review; mainnet agent, contract and anchored rule; hardware-wallet owner. | First mainnet sale bought by an agent we do not run |
| M2 | Q1 2027 | Stable pricing in a euro PLT stablecoin with real liquidity (EURR and USDR are frozen since May 2026). Testnet done: 2026-11-26 with our own test dollar `hh-VFUSD`, and 2026-11-27 with Concordium's allow-listed test euro `EUDemo` ([`2faa32b1…`](https://ccdexplorer.io/testnet/transaction/2faa32b102cb68365f64feef63245f2ef625aeb4a94a7018855ad5aee93866ab)); buyer and seller passed the allow list's EU-nationality proof first. | A buyer pays a fixed stablecoin price on mainnet |
| M3 | Q2 2027 | One agent platform integration (the MCP Registry listing and the GitHub Marketplace Action are done, 28 Nov 2026). | 10 distinct paying buyer accounts |
| M4 | Q2 2027 | More assets; 90 days of uninterrupted commits. Publish only what the anchored rule prints, against always-on and always-off. No hit rate. | 90-day public record |

## Costs

Measured from our own transactions; mainnet fees are fixed in euros by the chain, so the CCD amount moves with the CCD price.

| Item | Energy | Cost seen | Per year at our volume |
|---|---|---|---|
| Daily commit (contract update) | 1,244 NRG ([`d9527398…`](https://ccdexplorer.io/testnet/transaction/d952739813664933795fc43b5d2b4a99a5b0f3455472bad28349628a51f9bd03)) | Ͼ9.61 on testnet | 2 assets × 365 = 730 commits ≈ Ͼ7,000–7,500 |
| Reveal, 7 days later (contract update, about the same size) | about 1,250 NRG (estimate) | about Ͼ10 | about Ͼ7,300 |
| Eligibility record (VRA, then VAA), once per new buyer | 549 NRG ([`edc30fac…`](https://ccdexplorer.io/testnet/transaction/edc30fac188ba167b37e8f7338ce691a0f00932303201230576056e8a103a5d6)) | Ͼ4.22 each, Ͼ8.4 per buyer | Ͼ840 per 100 buyers |
| Buyer's payment fee | sponsored by the facilitator | 0 for us with the hosted one | if self-hosted: about Ͼ4 per sale |

For scale, a 513 NRG data registration on **mainnet** on 2026-11-26 cost Ͼ4.20 ([`9d1710ee…`](https://ccdexplorer.io/mainnet/transaction/9d1710ee2b15a697cb35c77b3ad084f262147b61e52dde3aa55a56d594f208bc)), close to testnet's rate. So the chain side is about Ͼ15,000 a year for the daily record, which at a CCD price of $0.003–0.005 ([Coinbase](https://www.coinbase.com/price/concordium), 2026-11-26) is roughly $45–75 a year.

Hosting: a Render instance that does not sleep, 512 MB, is $7 a month ([Render pricing](https://render.com/pricing)); the gateway is tested in CI at that memory cap. Neon's Launch plan has no minimum and bills compute at $0.106 per CU-hour ([Neon pricing](https://neon.com/pricing)); our database is small and idle most of the time, so a few dollars a month, under $20 even if it never scales to zero at 0.25 CU. Total to run the record on mainnet: on the order of $15–30 a month plus about $5 of CCD, before any sales, and a node (a provider, or a machine with 16 GB and 1 TB NVMe, likely $40–80 a month). One-off on-chain costs, measured on testnet at the same euro-fixed rates: module deployment about Ͼ350–400 per contract (the escrow's 45,001 NRG cost Ͼ353), init and role transactions a few tens of CCD, the rule anchor about Ͼ4, so under Ͼ1,300 (a few dollars) in all. A contract review and a legal review are one-off costs we have not been quoted; they, not the chain, set the timeline.

## Risks

| Risk | Handling |
|---|---|
| The signal underperforms | The record is public by design and buyers see it before paying. The promise is honesty, not alpha. |
| Regulatory classification | "Not investment advice" notice; zero-knowledge age and country checks; legal review before M1. |
| Server key compromise | The server cannot move the payout wallet or the agent. The committer key on testnet also pays for anchoring: a thief could commit today's call before the daily job and spend or transfer its few hundred test CCD. The owner can revoke its commit role with `revoke_committer`; the CCD is lost either way. `watch` alerts on any change to the agent or the contract roles. On mainnet the two roles get separate accounts holding a few days of fees each. |
| Price data access | Daily calls read Binance's public data host only. If a needed close is missing, the job does not commit that day, and the scoring rule counts the day as failed. A candle that has not closed is never used. The data source is part of the anchored rule, so a fallback cannot be added to the testnet rule after the fact; the mainnet rule (step 2) will name a second source (Coinbase or Kraken daily closes) and when it is used, before its first commit. |
