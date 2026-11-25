## Agent Registry census — testnet <12802,0>

Run 2026-11-25T06:32:41.327Z. Read-only: every agent read from a Concordium node (token ids 1–49888, stopping after 300 empty ids), Agent Cards fetched and hashed, x402 endpoints named in cards probed once with GET. No transactions, no payments.

**348 of 722 Active agents (48.2%) pass the on-chain checks a buyer can make before paying:** a bound `agentWallet`, and an https Agent Card whose SHA-256 equals the on-chain hash.

| | |
|---|---|
| Agents read | 23688 |
| Active | 722 (3%) |
| Revoked | 184 (0.8%) |
| Could not be decoded | 22782 (96.2%) |
| Active with an on-chain agentWallet | 621 (86%) |
| … of which the wallet is the owner account itself | 604 (83.7%) |
| Active whose https card loads | 456 (63.2%) |
| Active whose card cannot be loaded | 127 (17.6%) |
| Active with no https card | 137 (19%) |
| Active whose card matches the on-chain hash | 406 (56.2%) |
| Active whose card does NOT match the on-chain hash | 49 (6.8%) |
| Active declaring a Verified by Concordium badge in the card | 133 (18.4%) |
| Active linking an external (other-chain) key via external_reference | 99 (13.7%) |
| … key bound in CIS-8 to the agent's owner (read from a node) | 91 (91.9%) |
| … key bound in CIS-8 to a different account | 1 (1%) |
| … key not registered in CIS-8 | 0 (0%) |
| … CIS-8 binding revoked | 0 (0%) |
| … points at another contract | 0 (0%) |
| … CIS-8 read failed | 7 (7.1%) |
| Active whose card mentions x402 | 60 (8.3%) |
| … with a live x402 402 found at a URL in the card | 1 |
| … … Concordium payTo = on-chain agentWallet | 1 |
| … … Concordium payTo ≠ on-chain agentWallet | 0 |
| … … offering an EVM payTo | 0 |
| … … EVM offer naming a CIS-8 key in `extra` | 0 |

External key namespaces (Active): `aifleet` 68, `eip155:1` 9, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` 5, `eip155:11155111` 4, `cosmos:fetchhub-4` 4, `eip155:8453` 4, `skillmark:v1` 2, `solana:mainnet` 1.

Not checked here: the official badge check (a hosted service), CIS-8 bindings (the registry has no listing by account), endpoints not named in the card or not answering GET.

Run: https://github.com/jiahaoc040-ai/veriflow/actions/runs/45553340234 · code at commit cac0f4d6fa053d179fa265aa61cfa7aace8185d0 · per-agent rows in latest.json
