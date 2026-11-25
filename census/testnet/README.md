## Agent Registry census — testnet <12802,0>

Run 2026-11-25T06:39:53.980Z. Read-only: every agent read from a Concordium node (token ids 1–1501, stopping after 300 empty ids), Agent Cards fetched and hashed, x402 endpoints named in cards probed once with GET. No transactions, no payments.

**678 of 1219 Active agents (55.6%) pass the on-chain checks a buyer can make before paying:** a bound `agentWallet`, and an https Agent Card whose SHA-256 equals the on-chain hash.

| | |
|---|---|
| Agents read | 1501 |
| Active | 1219 (81.2%) |
| Revoked | 282 (18.8%) |
| Could not be decoded | 0 (0%) |
| Active with an on-chain agentWallet | 1042 (85.5%) |
| … of which the wallet is the owner account itself | 1011 (82.9%) |
| Active whose https card loads | 869 (71.3%) |
| Active whose card cannot be loaded | 167 (13.7%) |
| Active with no https card | 181 (14.8%) |
| Active whose card matches the on-chain hash | 811 (66.5%) |
| Active whose card does NOT match the on-chain hash | 57 (4.7%) |
| Active declaring a Verified by Concordium badge in the card | 272 (22.3%) |
| Active linking an external (other-chain) key via external_reference | 241 (19.8%) |
| … key bound in CIS-8 to the agent's owner (read from a node) | 240 (99.6%) |
| … key bound in CIS-8 to a different account | 1 (0.4%) |
| … key not registered in CIS-8 | 0 (0%) |
| … CIS-8 binding revoked | 0 (0%) |
| … points at another contract | 0 (0%) |
| … CIS-8 read failed | 0 (0%) |
| Active whose card mentions x402 | 130 (10.7%) |
| … with a live x402 402 found at a URL in the card | 2 |
| … … Concordium payTo = on-chain agentWallet | 1 |
| … … Concordium payTo ≠ on-chain agentWallet | 1 |
| … … offering an EVM payTo | 0 |
| … … EVM offer naming a CIS-8 key in `extra` | 0 |

External key namespaces (Active): `aifleet` 100, `solana:devnet` 30, `concordium` 29, `eip155:1` 18, `fetchai` 10, `eip155:11155111` 6, `cosmos:fetchhub-4` 6, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` 5.

Not checked here: the official badge check (a hosted service), CIS-8 bindings (the registry has no listing by account), endpoints not named in the card or not answering GET.

Run: https://github.com/jiahaoc040-ai/veriflow/actions/runs/45561554761 · code at commit 974ab20951ab414fc1e5eef8f683d12c2f516b10 · per-agent rows in latest.json
