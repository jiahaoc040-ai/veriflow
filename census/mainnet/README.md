## Agent Registry census — mainnet <10082,0>

Run 2026-11-25T06:32:39.266Z. Read-only: every agent read from a Concordium node (token ids 1–49872, stopping after 300 empty ids), Agent Cards fetched and hashed, x402 endpoints named in cards probed once with GET. No transactions, no payments.

**2028 of 2872 Active agents (70.6%) pass the on-chain checks a buyer can make before paying:** a bound `agentWallet`, and an https Agent Card whose SHA-256 equals the on-chain hash.

| | |
|---|---|
| Agents read | 26684 |
| Active | 2872 (10.8%) |
| Revoked | 8 (0%) |
| Could not be decoded | 23804 (89.2%) |
| Active with an on-chain agentWallet | 2108 (73.4%) |
| … of which the wallet is the owner account itself | 2107 (73.4%) |
| Active whose https card loads | 2347 (81.7%) |
| Active whose card cannot be loaded | 498 (17.3%) |
| Active with no https card | 27 (0.9%) |
| Active whose card matches the on-chain hash | 2303 (80.2%) |
| Active whose card does NOT match the on-chain hash | 44 (1.5%) |
| Active declaring a Verified by Concordium badge in the card | 1177 (41%) |
| Active linking an external (other-chain) key via external_reference | 1177 (41%) |
| … key bound in CIS-8 to the agent's owner (read from a node) | 1057 (89.8%) |
| … key bound in CIS-8 to a different account | 0 (0%) |
| … key not registered in CIS-8 | 0 (0%) |
| … CIS-8 binding revoked | 0 (0%) |
| … points at another contract | 0 (0%) |
| … CIS-8 read failed | 120 (10.2%) |
| Active whose card mentions x402 | 84 (2.9%) |
| … with a live x402 402 found at a URL in the card | 0 |
| … … Concordium payTo = on-chain agentWallet | 0 |
| … … Concordium payTo ≠ on-chain agentWallet | 0 |
| … … offering an EVM payTo | 0 |
| … … EVM offer naming a CIS-8 key in `extra` | 0 |

External key namespaces (Active): `eip155:1` 319, `ccd:9dd9ca4d19e9393877d2c44b70f89acb` 275, `near:mainnet` 227, `cosmos:fetchhub-4` 191, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` 127, `fetchai` 29, `eip155:50` 6, `eip155:42220` 1.

Not checked here: the official badge check (a hosted service), CIS-8 bindings (the registry has no listing by account), endpoints not named in the card or not answering GET.

Run: https://github.com/jiahaoc040-ai/veriflow/actions/runs/45553337509 · code at commit cac0f4d6fa053d179fa265aa61cfa7aace8185d0 · per-agent rows in latest.json
