## Agent Registry census — mainnet <10082,0>

Run 2026-11-25T07:19:00.937Z. Read-only: every agent read from a Concordium node (token ids 1–5403, stopping after 300 empty ids), Agent Cards fetched and hashed, x402 endpoints named in cards probed once with GET. No transactions, no payments.

**4124 of 5393 Active agents (76.5%) pass the on-chain checks a buyer can make before paying:** a bound `agentWallet`, and an https Agent Card whose SHA-256 equals the on-chain hash.

| | |
|---|---|
| Agents read | 5403 |
| Active | 5393 (99.8%) |
| Revoked | 9 (0.2%) |
| Could not be decoded | 1 (0%) |
| Active with an on-chain agentWallet | 4279 (79.3%) |
| … of which the wallet is the owner account itself | 4278 (79.3%) |
| Active whose https card loads | 4660 (86.4%) |
| Active whose card cannot be loaded | 665 (12.3%) |
| Active with no https card | 68 (1.3%) |
| Active whose card matches the on-chain hash | 4604 (85.4%) |
| Active whose card does NOT match the on-chain hash | 56 (1%) |
| Active declaring a Verified by Concordium badge in the card | 2295 (42.6%) |
| Active linking an external (other-chain) key via external_reference | 2600 (48.2%) |
| … key bound in CIS-8 to the agent's owner (read from a node) | 2599 (100%) |
| … key bound in CIS-8 to a different account | 0 (0%) |
| … key not registered in CIS-8 | 0 (0%) |
| … CIS-8 binding revoked | 0 (0%) |
| … points at another contract | 0 (0%) |
| … CIS-8 read failed | 1 (0%) |
| Active whose card mentions x402 | 322 (6%) |
| … with a live x402 402 found at a URL in the card | 1 |
| … … Concordium payTo = on-chain agentWallet | 0 |
| … … Concordium payTo ≠ on-chain agentWallet | 0 |
| … … offering an EVM payTo | 1 |
| … … EVM offer naming a CIS-8 key in `extra` | 0 |

Why the other 1269 fail, each agent counted once: no agentWallet, and the card also fails 634; no agentWallet, card fine 480; wallet bound but no https card 68; wallet bound but the card does not load 31; wallet bound but the card changed since it was pinned 56.

External key namespaces (Active): `eip155:1` 623, `near:mainnet` 611, `ccd:9dd9ca4d19e9393877d2c44b70f89acb` 480, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` 445, `cosmos:fetchhub-4` 380, `fetchai` 41, `eip155:50` 17, `eip155:42220` 1, `eip155:8453` 1, `tgtrust:v1` 1.

Not checked here: the official badge check (a hosted service); CIS-8 keys an agent does not link through external_reference (CIS-8 has no listing by account); endpoints not named in the card or not answering GET.

Run: https://github.com/jiahaoc040-ai/veriflow/actions/runs/45562962557 · code at commit 043680f806404dce2f03c628fe97c15fc4f3ba53 · per-agent rows in latest.json

_This README was re-rendered on 2026-11-26 from the same latest.json, with code from main: all namespaces listed, the failures broken down so they add up, and the not-checked list corrected (CIS-8 keys linked through external_reference are checked). No count changed._
