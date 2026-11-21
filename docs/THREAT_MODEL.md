# VeriFlow threat model

VeriFlow sells a crypto risk-regime signal (RISK_ON / RISK_OFF for BTC and ETH) to AI agents over x402 on Concordium. Three parties can cheat: the **seller** (us), the **buyer**, and **anyone in between**. This document lists each attack, the defence, where it lives in the code, and what is still not covered.

Status: everything below runs on Concordium **testnet** today, on the public deployment <https://veriflow-yrhp.onrender.com>.

## Assets worth protecting

| Asset | Why it matters |
|---|---|
| The track record | The whole product. A buyer pays because past calls were real. |
| The buyer's money | Agents pay autonomously; a mistake is a lost payment, not a prompt. |
| The buyer's personal data | Eligibility (age, residence) must be proven without being revealed or stored. |
| The seller's compliance | Selling investment information to minors or to restricted jurisdictions is the seller's liability. |
| Operator keys | The sponsor/anchor account signs every commitment and pays fees. |

## A dishonest seller (us)

| Attack | Defence | Code |
|---|---|---|
| Edit a past signal after the outcome | Each signal's SHA-256 (canonical JSON with a random nonce) is committed on-chain when issued. Change one character and the hash no longer matches. | `veriflow/signal.py`, `gateway/src/verify.ts` |
| Write a "prediction" after the outcome is known (backdating) | Every verifier checks the **block time** of the anchor: it must be within a day of the data close, long before the 7-day outcome. A late anchor fails verification. | `anchoredInTime` in `verify.ts`, `veriflow/verify.py`, dashboard |
| Cherry-pick: only publish the calls that worked | The server commits **one signal per asset every daily close** on its own schedule, whether or not anyone buys. Gaps would be visible. | `gateway/src/daily.ts`, `POST /daily/{asset}` |
| Commit both outcomes (two nonces, or a second commit under another asset label), reveal only the winner, delete the loser from the database | **Not rejected by the deployed contract `<13094,0>`**: it refuses only a repeated hash, and a reveal is optional. Defence today is counting from the chain, not from our database: every owner `commit` event, with no asset filter, must be the only one for its asset and day and must be revealed after the horizon; anything else counts as a failure. Contract v2 rejects a second commit for the same `(asset, as_of)`. | planned: chain-only integrity script; contract v2 |
| Inflate the hit rate by selling the same day many times | Each sale gets a fresh nonce (fresh commitment), and the live ledger scores **each asset-day once** (earliest anchored). That dedup hides duplicates rather than flagging them: the 19 Nov pairs exist on-chain. The integrity count must treat a second commit for an asset-day as a failure. | `Ledger.track_record` |
| Score signals that were never anchored | Only anchored signals are scored. | `Ledger.track_record` |
| Overwrite or delete a commitment | The Rust registry contract `<13094,0>` stores commitments; only the owner can commit, nobody can overwrite, and after the horizon **anyone** can reveal — the contract recomputes the hash on-chain. | `contract/src/lib.rs` (8 end-to-end tests) |
| Lie about what is on-chain | The buyer can avoid our server: hash the canonical it bought and compare it with the commit on a block explorer. The local MCP `verify_signal` tool and the Python verifier read the anchor **directly from a Concordium node** (they still use our decoder). The dashboard recomputes hashes in the browser but reads the anchor through our `/onchain` endpoint, so it is a convenience, not an independent check. | `readAnchorTx` in `gateway/src/anchor.ts`, `gateway/src/mcp.ts` |
| Hide behind an anonymous identity | Agent #1313 in the Concordium Agent Registry carries the Verified by Concordium badge: the owner account is identity-verified. The Agent Card's hash is pinned on-chain. | `agent-card.json`, `gateway/src/registry.ts` |

## A dishonest or ineligible buyer

| Attack | Defence | Code |
|---|---|---|
| Minor or restricted-country resident buys | Verify & Access V1 zero-knowledge proof (age ≥ 18, residence not in CU/IR/KP/SY/US) is required **before payment settles**; the facilitator's `onBeforeVerify` hook refuses unverified payers. | `gateway/src/eligibility.ts`, `gateway/src/gateway.ts` |
| Use someone else's credential | The proof must come from an **account credential owned by the paying account**; identity credentials not linked to the account are refused. | `EligibilityService.verify` |
| Replay an old proof | One-time challenge, 10-minute TTL, anchored on-chain as a Verification Request (VRA); the audit record (VAA) is anchored too. | `EligibilityStore.take` |
| Weaker statement (e.g. age ≥ 16) | The presented statements are compared to the policy exactly; anything weaker is refused. Changing the policy invalidates earlier verifications (policy fingerprint). | `statementGap`, `policyId` |
| Unknown identity provider | Issuer must be one of the identity providers registered on-chain. | `identityProviders()` |

Nothing personal is stored: VeriFlow keeps the account address, the policy fingerprint and the two transaction hashes.

## Attacks on the buyer (impersonation, overcharging)

| Attack | Defence | Code |
|---|---|---|
| A scam endpoint copies VeriFlow's badge and Agent Card but asks to be paid at its own address | Before signing, the buyer checks that the x402 `payTo` equals the agent's **on-chain `agentWallet`** in the CIS-8004 registry. VeriFlow bound its payout account on-chain ([setAgentWallet tx](https://ccdexplorer.io/testnet/transaction/8238b866de05398d95fd66be64a74b1f0e86279cd2b748838ebaa5fd4e44e33b)). | `gateway/src/counterparty.ts` |
| Agent Card swapped after it was vouched for | The buyer downloads the card itself and recomputes SHA-256 against the on-chain `metadata_hash`. | `verifySeller` |
| Revoked agent, fake or invalid badge | `agent_by_token_address` must be Active; the official `check_badge` must pass. | `verifySeller` |
| Registry outage used to slip a payment through | Fail closed: no registry answer, no payment. The check runs in the x402 client's `onBeforePaymentCreation` hook, so the wallet is never asked. | `gateway/src/agent.ts` |
| Seller raises the price or switches asset | x402 spend controls: CCD only, at most `MAX_PAY_MICROCCD` (2 CCD) per payment. | `gateway/src/agent.ts` |
| Pay for a failed request | x402 settles only after the resource returns successfully; an error response is never charged. | `@x402/express` flow |

## Infrastructure

| Attack | Defence |
|---|---|
| Key leakage | Keys live only in `gateway/keys/` (git-ignored) and in host secrets; GitHub push protection and secret scanning are on. The setAgentWallet authorization is checked byte by byte (token, owner, wallet, deadline, contract, chain) before the payout key signs it. |
| Concurrent buyers making the operator's transactions collide (same nonce → one rejected) | Every transaction from the operator account goes through one queue: fetch nonce → sign → send, one at a time, with locally tracked nonces when the node lags; the SDK's own eligibility anchors wait until the node has caught up. Tested with 10 simultaneous purchases. (`gateway/src/txqueue.ts`) |
| Burning the operator's CCD by spamming eligibility challenges (each anchors a transaction) | Rate limits: 5 per IP per 10 min, 3 per account per hour, 60 per hour site-wide. |
| Web attacks on the dashboard and `/verify` | Strict CSP with hashed inline scripts and styles, CORP/COEP, no-store, HSTS, nosniff; weekly OWASP ZAP baseline scan, CodeQL, Trivy, Dependabot. |
| Price source outage or blocking | Binance public hosts, then OKX spot daily candles (same UTC day boundary). A refresh failure reuses data only if it already contains yesterday's close; otherwise the request fails — no stale signal is issued. |

## Residual risks (honest list)

1. **Signal quality is not guaranteed.** The protocol proves *when* a call was made and that it was not changed — not that it is right. The hit rate is public so buyers can judge.
2. **Operator key is hot.** The anchor/sponsor key runs on the server. Mainnet plan: hardware-backed signing and a separate, cold payout account (already separate: payouts go to `3WSA…`, the server key is `4dNM…`).
3. **Testnet identity providers** issue test identities; mainnet eligibility depends on real identity providers.
4. **The badge owner key is the hot server key.** `4dNM…` owns agent #1313, is the only account that can `commit`, and pays fees, and its key is on the host. A shell on the server can re-point `agentWallet` and pass every buyer check. Fix before mainnet: cold owner, separate low-balance committer (contract v2), alert on `setAgentWallet`/`setAgentURI`, and setting the agent `Inactive` as the incident response.
5. **Seller could stop issuing.** Daily commitments make silence visible, but cannot force the seller to keep publishing.
6. **The gateway can refuse service** (censorship of a particular buyer). It cannot charge without delivering, but it can decline to sell.
