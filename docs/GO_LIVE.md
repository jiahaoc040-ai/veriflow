# Path to production: testnet → mainnet → real users

## What runs today (testnet)

Everything below is live on Concordium testnet at <https://veriflow-yrhp.onrender.com>, with transactions anyone can open. Some parts are testnet stand-ins, listed after.

- **x402 v2 payments.** 1 CCD per call, paid to agent #1313's on-chain `agentWallet`. The 402 names the agent (`concordium-agent` extension), and our buyer refuses to sign unless the registry, read from a node, agrees on the wallet.
- **Verify & Access V1 eligibility.** A zero-knowledge proof of age ≥ 18 and residence outside a restricted list. The request (VRA) and audit record (VAA) are anchored on-chain, and the proof is re-checked against the live policy at settlement.
- **Agent #1313 in the CIS-8004 Agent Registry `<12802,0>`.** Verified by Concordium badge, Agent Card hash pinned on-chain, payout wallet bound on-chain. The owner account is kept offline.
- **Contract v2 `<13115,0>`.** One call per asset and day, accepted only in the day after the close, revealed after 7 days, label checked against momentum on reveal. The owner key is offline. The server holds a separate committer key, which on testnet is also the fee sponsor and holds a few hundred test CCD.
- **Scoring rule anchored before the first call** and re-run by a public GitHub workflow four times a day.
- **MCP server** that Claude Desktop uses to check the seller, pay, and verify the call on-chain.

**Testnet stand-ins:**
- Identities come from testnet identity providers.
- We run our own x402 facilitator and sponsor buyers' fees. Concordium runs a hosted testnet facilitator that issues API keys to hackathon teams; moving settlement to it is a configuration change once we have a key.
- Eligibility is cached in our database after the proof; settlement re-checks the stored proof and its on-chain anchors, but buyers still rely on our server to run that check.
- The only buyer so far is us.

## What changes for mainnet

The network is one setting, `CONCORDIUM_NETWORK` (`testnet` or `mainnet`), in `gateway/src/network.ts`. It drives the x402 CAIP-2 network, the Verify & Access DID network, the CIS-8004 registry contract the buyer reads (testnet `<12802,0>`; mainnet `<10082,0>`, the address [Concordium publishes](https://docs.concordium.com/en/mainnet/technical-reference/agent-registry/index.html)) and the explorer links. A build test fails if the testnet or mainnet network strings, explorer URLs or CAIP-2 constants, or either registry index, appear in code (not comments) of any other file in `gateway/src`. Three files are exempt: `network.ts` itself, and the two scoring scripts, which name the testnet deployment on purpose (`score-v2.ts` is frozen by its on-chain hash; `score.ts` scores only the retired v1 contract). Mainnet gets its own anchored rule (step 2 below). Before it accepts connections, the gateway asks its node for the chain's genesis and exits if it belongs to the other network; it repeats this every minute. It tries up to three times (each gRPC call times out after 20 seconds). If all three fail without an answer, it starts anyway and logs a warning, since payments cannot settle without a working node, and exits at the first later check that sees the other network. A node that switched chains after a passing check is caught within about a minute. The embedded facilitator listens on 127.0.0.1 only, before this check.

The setting is not the whole job. Mainnet also needs:

1. **A new agent.** Register in the mainnet Agent Registry `<10082,0>` from a mainnet identity, get the badge, and bind a mainnet `agentWallet`. The agent id will differ from #1313; the buyer reads it from the 402 and the registry, not from code.
2. **A new contract and a new anchored rule.** Deploy contract v2 to mainnet after an external review, then anchor a scoring rule that names the mainnet contract and module before its first commit, exactly as on testnet.
3. **Key handling.** Owner key on a hardware wallet. Split the committer and the fee sponsor into two accounts, each topped up by hand with a few days of fees.
4. **Pricing.** 1 CCD is not a stable price. The x402 Concordium scheme we already use (`@x402/concordium`) settles PLT tokens such as EURR by setting `price.asset` to the token id ([package README](https://github.com/x402-foundation/x402/blob/main/typescript/packages/mechanisms/concordium/README.md)). The scheme needs no change. In this repo the price field and the buyer's spend limit, which today only allows CCD, do.
5. **Legal review** of selling a market signal to anonymous agents, before the first mainnet sale. The restricted-country list is one configuration value.

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
| M2 | Q1 2027 | Stable pricing in a PLT stablecoin (EURR or USDR). | A buyer pays a fixed stablecoin price |
| M3 | Q2 2027 | One agent platform integration; MCP Registry listing. | 10 distinct paying buyer accounts |
| M4 | Q2 2027 | More assets; 90 days of uninterrupted commits. Publish only what the anchored rule prints, against always-on and always-off. No hit rate. | 90-day public record |

## Costs

On-chain fees are small: each commit, sponsored payment and eligibility anchor costs a small amount of CCD. Hosting today is a free-tier container and a free-tier Postgres database; mainnet needs an always-on paid instance. We have not priced it yet and do not quote a number here.

## Risks

| Risk | Handling |
|---|---|
| The signal underperforms | The record is public by design and buyers see it before paying. The promise is honesty, not alpha. |
| Regulatory classification | "Not investment advice" notice; zero-knowledge age and country checks; legal review before M1. |
| Server key compromise | The server cannot move the payout wallet or the agent. The committer key on testnet is also the fee sponsor: a thief could commit today's call before the daily job, spend or transfer its few hundred test CCD, and sponsor fees. The owner can revoke its commit role with `revoke_committer`; the CCD is lost either way. `watch` alerts on any change to the agent or the contract roles. On mainnet the two roles get separate accounts holding a few days of fees each. |
| Price data access | Daily calls read Binance's public data host only. If a needed close is missing, the job does not commit that day, and the scoring rule counts the day as failed. A candle that has not closed is never used. |
