# VeriFlow threat model

VeriFlow sells a crypto risk-regime signal (RISK_ON / RISK_OFF for BTC and ETH) to AI agents over x402 on Concordium. Three parties can cheat: the **seller** (us), the **buyer**, and **anyone in between**. This document lists each attack, the defence, where it lives in the code, and what is still not covered.

Status: everything below runs on Concordium **testnet** today, on the public deployment <https://veriflow-yrhp.onrender.com>.

## Assets worth protecting

| Asset | Why it matters |
|---|---|
| The record of calls | A buyer pays because past calls were committed before their outcomes and never changed. |
| The buyer's money | Agents pay autonomously; a mistake is a lost payment, not a prompt. |
| The buyer's personal data | Eligibility (age, residence) must be proven without being revealed or stored. |
| The seller's compliance | Selling investment information to minors or to restricted jurisdictions is the seller's liability. |
| Operator keys | The sponsor/anchor account signs every commitment and pays fees. |

## A dishonest seller (us)

| Attack | Defence | Code |
|---|---|---|
| Edit a past signal after the outcome | Each signal's SHA-256 (canonical JSON with a random nonce) is committed on-chain when issued. Change one character and the hash no longer matches. | `veriflow/signal.py`, `gateway/src/verify.ts` |
| Write a "prediction" after the outcome is known (backdating) | Every verifier checks the **block time** of the anchor: it must be after the data close and within a day of it, long before the 7-day outcome. An early, late or undated anchor fails verification. | `anchoredInTime` in `gateway/src/verify.ts`, `anchored_in_time` in `veriflow/verify.py`, the dashboard; contract v2 enforces the same window on-chain at `commit` |
| Cherry-pick: only publish the calls that worked | The `daily-v2` workflow commits **one call per asset for every daily close** to contract v2 from the committer `4Hga…`, hourly from 00:17 UTC until it succeeds, whether or not anyone buys. A missing day is a failed slot in the scoring rule. | `.github/workflows/daily-v2.yml`, `gateway/src/daily-v2.ts` |
| Commit both outcomes (two nonces, or a second commit under another asset label), reveal only the winner, delete the loser from the database | **Rejected by contract v2 `<13115,0>`** (one key per asset and day, BTC/ETH only, commit only in the day after the close; a call unrevealed after its exit blocks the score). **Not rejected by the retired v1 contract `<13094,0>`**: it refuses only a repeated hash, and a reveal is optional. Both scoring scripts count from the chain, not from our database. `score-v2.ts` reads every required `(asset, as_of)` slot of contract v2 from a node, checks the slot count against the contract's `issued` counter, and requires each due call to be revealed and to match Binance. `score.ts` reads the v1 contract's `commit` events from CCDScan and counts an asset-day with more than one commit, or none, as a failure. | `gateway/src/score-v2.ts` (`score-v2` workflow), `gateway/src/score.ts`; contract v2 |
| Sell the same day many times with different answers | **Contract v2 `<13115,0>` rejects a second call for the same asset and day**, and every buyer of that day gets the same committed call. On v1 each sale got a fresh nonce (fresh commitment), so the same asset-day could be committed more than once: the 19 Nov pairs exist on-chain. The ledger lists them under `duplicate_asset_days`, and the v1 scoring script counts any asset-day with more than one commit as a failed day. | `Ledger.track_record`, `gateway/src/score.ts` |
| Score signals that were never anchored | Only anchored signals are scored. | `Ledger.track_record` |
| Overwrite or delete a commitment | The Rust registry contract `<13094,0>` stores commitments; only the owner can commit, nobody can overwrite, and after the horizon **anyone** can reveal — the contract recomputes the hash on-chain. | `contract/src/lib.rs`; 8 end-to-end tests in `contract/tests/tests.rs` |
| Lie about what is on-chain | The buyer can avoid our server: hash the canonical it bought and compare it with the commit on a block explorer. The local MCP `verify_signal` tool finds the transaction hash through our `/commitments` list, then reads that transaction **from a Concordium node** and decodes v1 data and v2 `Committed` events with our decoder. Our server can therefore hide a commitment (it is reported as not anchored), but cannot make a different one pass. The Python `veriflow/verify.py` only checks values it is given; it does not read a node or decode v2 events. The dashboard recomputes hashes in the browser but reads the anchor through our `/onchain` endpoint, so it is a convenience, not an independent check. | `readAnchorTx` in `gateway/src/anchor.ts`, `gateway/src/mcp.ts` |
| Hide behind an anonymous identity | Agent #1313 in the Concordium Agent Registry carries the Verified by Concordium badge: the owner account is identity-verified. The Agent Card's hash is pinned on-chain. | `agent-card.json`, `gateway/src/registry.ts` |

## A dishonest or ineligible buyer

| Attack | Defence | Code |
|---|---|---|
| Minor or restricted-country resident buys | Verify & Access V1 zero-knowledge proof (age ≥ 18, residence not in CU/IR/KP/SY/US) is required **before payment settles**; the facilitator's `onBeforeVerify` hook refuses unverified payers. | `gateway/src/eligibility.ts`, `gateway/src/gateway.ts` |
| Use someone else's credential | The proof must come from an **account credential owned by the paying account**; identity credentials not linked to the account are refused. | `EligibilityService.verify` |
| Replay an old proof | One-time challenge, 10-minute TTL, anchored on-chain as a Verification Request (VRA); the audit record (VAA) is anchored too. | `EligibilityStore.take` |
| Weaker statement (e.g. age ≥ 16) | The presented statements are compared to the policy exactly; anything weaker is refused. Changing the policy invalidates earlier verifications (policy fingerprint). | `statementGap`, `policyId` |
| Unknown identity provider | Issuer must be one of the identity providers registered on-chain. | `identityProviders()` |

What is stored: the account address, the policy fingerprint, the two transaction hashes, the credential id and the buyer's zero-knowledge proof. The proof is kept so that every payment can be re-checked, and it reveals neither the date of birth nor the country. Neither the proof nor the credential id is returned by any public endpoint. Settlement re-runs the official check on that proof each time and refuses on any error. It also checks the proof against the current policy and identity-provider list, and it requires both the request and the audit record to have been anchored by VeriFlow's own account. A row inserted into the database, even with a real proof the attacker anchored themselves, cannot buy. The facilitator listens on 127.0.0.1 only.

## Attacks on the buyer (impersonation, overcharging)

| Attack | Defence | Code |
|---|---|---|
| A scam endpoint copies VeriFlow's badge and Agent Card but asks to be paid at its own address | Before signing, the buyer checks that the x402 `payTo` equals the agent's **on-chain `agentWallet`** in the CIS-8004 registry. VeriFlow bound its payout account on-chain ([setAgentWallet tx](https://ccdexplorer.io/testnet/transaction/8238b866de05398d95fd66be64a74b1f0e86279cd2b748838ebaa5fd4e44e33b)). | `gateway/src/counterparty.ts` |
| Agent Card swapped after it was vouched for | The buyer downloads the card itself and recomputes SHA-256 against the on-chain `metadata_hash`. | `verifySeller` |
| The 402 names a different agent, or none | The 402 must carry the `concordium-agent` extension naming this network, this network's registry contract, a token id and a badge. The badge must be the one on the served Agent Card, and the card's badge must resolve to that token id. The registry record is then read from a Concordium node with `agentOf`; a record whose id is not the one asked for, or that does not decode strictly, refuses payment. | `gateway/src/agent.ts`, `gateway/src/registry-node.ts` |
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
| Price source outage or blocking | v2 reads only Binance's public data host (`data-api.binance.vision`). A missing close means no commit that day, which the scoring rule counts as a failed day. A candle that has not closed is never used. (v1 also fell back to OKX; v2 drops the fallback so the input cannot be chosen after the fact.) |

## Residual risks (honest list)

1. **Signal quality is not guaranteed.** The protocol proves *when* a call was made and that it was not changed — not that it is right. No hit rate is published. The anchored rule prints performance only against both constant books, and only once days mature.
2. **The committer key is hot.** `4Hga…` signs the daily commits and sponsors buyer fees, and its key is on the server and in GitHub Actions secrets. It holds a few hundred test CCD. It cannot set the agent's wallet or card, or the contract's committer. It can commit inside the daily window, reveal (anyone can), sponsor fees, and transfer its own CCD. The cold owner can revoke its commit role with `revoke_committer`; that does not protect its balance. Mainnet plan: hardware-backed signing.
3. **Testnet identity providers** issue test identities; mainnet eligibility depends on real identity providers.
4. **The badge-to-agent lookup trusts Concordium's hosted registry service.** The buyer reads the agent record from a node, but which token id a badge belongs to comes from `agent-registry-mcp.concordium.com`. A lying hosted service could map VeriFlow's badge to another real agent, and the buyer would then pay that agent's on-chain wallet. The 402 alone cannot cause this. The buyer also pays whichever agent `GATEWAY_URL`'s card names; it does not pin #1313, so the operator of the gateway URL you choose decides which verified agent you deal with. `REQUIRE_SELLER_BADGE=false` turns the whole check off.
5. **Fixed on 2026-11-22: the badge owner key is no longer on the server.** `4dNM…` owns agent #1313 and contract v2 and stays on the owner's machine. The server and the daily job use the committer `4Hga…`. A shell on the host can no longer re-point `agentWallet` or the Agent Card. The `watch` workflow fails if the agent's owner, wallet, card or status changes, or the live 402 stops matching it. Still to do: setting the agent `Inactive` as the incident response.
6. **Seller could stop issuing.** Daily commitments make silence visible, but cannot force the seller to keep publishing.
6. **The gateway can refuse service** (censorship of a particular buyer). It cannot charge without delivering, but it can decline to sell.
