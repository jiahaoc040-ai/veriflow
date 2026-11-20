# VeriFlow go-live plan: testnet → mainnet → real users

## Where we are (testnet, live today)

Every piece runs for real on Concordium testnet at <https://veriflow-yrhp.onrender.com>. Nothing is mocked.

- **x402 payments** with a self-hosted facilitator that sponsors the fee.
- **Verify & Access V1 eligibility**, with zero-knowledge proofs and both the request and the audit record anchored on-chain.
- **A Rust commit–reveal contract**, `<13094,0>`.
- **Agent #1313 in the Agent Registry**: it carries the Verified by Concordium badge (15/15 checks pass), the Agent Card hash is pinned on-chain, and the payout wallet is bound on-chain.
- **An MCP server**, already used by Claude Desktop to verify the seller, pay, and verify the signal on-chain.
- **Daily signals**: one per asset per daily close, committed on-chain automatically.

So "going live" is a configuration and operations change, not a rewrite.

## Who the users are

1. **Autonomous trading and treasury agents.** Today they consume signals from Telegram channels and dashboards with unverifiable histories. VeriFlow gives them a regime signal they can check on-chain before paying, per call, with no account or subscription.
2. **Agent platforms with verified humans behind agents**, such as AITECH's Agent Forge and XDC AI, which already use Concordium identity. A VeriFlow MCP or A2A tool is a drop-in "market regime" capability for their agents.
3. **Other signal sellers.** VeriFlow is also a pattern: commit-before-outcome, daily public commitments, and scoring per asset-day. Any data seller who wants an unfakeable track record can reuse it (MIT licensed).

## Why someone pays

- A buyer can check the full live record before paying (`get_track_record`, `list_commitments`), for free.
- One call costs about one coffee-sip: about 1 CCD today, a stable price after the move to stablecoins (see M2).
- Compliance is built in. The seller never learns who the buyer is, only that they are 18 or older and not in a restricted country. This is what lets a regulated-style product sell to anonymous agents at all.

## Milestones

| # | When | What | Done when |
|---|---|---|---|
| M0 | Dec 2026 (hackathon) | Testnet product above, daily track record accumulating, first 7-day scores (from Nov 27) | Public dashboard shows scored signals; all links on CCDExplorer |
| M1 | Jan 2027 | **Mainnet deployment.** Deploy the registry contract to mainnet. Register the agent in the mainnet Agent Registry (CIS-8004 `<10082,0>`) with the badge and an on-chain `agentWallet`. Point the facilitator and Verify & Access at mainnet identity providers. | First mainnet sale verified end to end by a third-party agent |
| M2 | Q1 2027 | **Stable pricing.** Price in a Concordium PLT stablecoin (e.g. EURQ) instead of CCD. `@x402/concordium` already supports PLT transfers, so this is a change to the gateway's price configuration, not to the payment code. | Buyers pay a fixed euro price |
| M3 | Q1 2027 | **Distribution.** List in the MCP Registry, publish a hosted remote MCP endpoint, and add A2A skills. Integrate with one agent platform that already uses Concordium identity. | 10 distinct paying buyer accounts |
| M4 | Q2 2027 | **Track record at scale.** Add more assets (SOL, majors), and run 90 days of daily, uninterrupted commitments. Publish the hit rate with confidence intervals. | 90-day public record |
| M5 | Q2 2027 | **Hardening.** Hardware-backed signing for the anchor/sponsor key, monitored facilitator balance, and paid hosting with an SLA. Get an external review of the contract. | Audit report published |

## What it costs to run

| Item | Testnet today | Mainnet |
|---|---|---|
| Hosting (API, gateway, facilitator in one container) | Render free tier | ~$7–25/month for an always-on instance (estimate) |
| Database | Neon Postgres, free tier | Neon paid tier, ~$20/month (estimate) |
| On-chain fees | Test CCD | Each daily commitment, each sponsored payment, and each eligibility anchor costs a fraction of a cent in CCD. It is covered by sales once there are more than a handful a day. |

Revenue goes to a separate payout account that the server cannot sign for. The server holds only the anchor/sponsor key.

## Risks and how we handle them

| Risk | Mitigation |
|---|---|
| The signal underperforms | The record is public by design. Buyers see this before paying, and we cannot hide it. The product's promise is honesty, not alpha. |
| Regulatory classification of signals | The product carries a "not investment advice" notice. ZK eligibility enforces age and restricted-country rules. The list of restricted countries is a single configuration value. Legal review comes before M1. |
| Price data access from cloud hosts | We use several sources: Binance public hosts, then OKX. If a refresh fails, the server keeps using data that already includes the latest close. Otherwise the request fails, and no stale signal is ever issued. |
| Key compromise | The payout account is separate from the server key. Push protection and secret scanning are on. Hardware-backed signing comes in M5. |

## Grant use (Concordium grants programme)

Funding would go to M1 (mainnet deployment and the contract review), M3 (distribution and integration with an agent platform), and M4 (more assets and a 90-day public record). Each tranche is tied to a milestone that anyone can check on CCDExplorer.
