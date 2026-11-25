## Agent Registry census — mainnet <10082,0>

**Partial:** stopped at the 40-minute budget; agents above id 29769 were not read.

Run 2026-11-25T05:19:04.155Z. Read-only: every agent read from a Concordium node (token ids 1–29769), Agent Cards fetched and hashed, x402 endpoints named in cards probed once with GET. No transactions, no payments.

**1162 of 1771 Active agents (65.6%) pass the on-chain checks a buyer can make before paying:** a bound `agentWallet`, and an https Agent Card whose SHA-256 equals the on-chain hash.

| | |
|---|---|
| Agents read | 17169 |
| Active | 1771 (10.3%) |
| Revoked | 8 (0%) |
| Not decoded (external_reference set; status unknown) | 15390 (89.6%) |
| Active with an on-chain agentWallet | 1248 (70.5%) |
| … of which the wallet is the owner account itself | 1247 (70.4%) |
| Active whose https card loads | 1178 (66.5%) |
| Active whose card cannot be loaded | 530 (29.9%) |
| Active with no https card | 63 (3.6%) |
| Active whose card matches the on-chain hash | 1162 (65.6%) |
| Active whose card does NOT match the on-chain hash | 16 (0.9%) |
| Active declaring a Verified by Concordium badge in the card | 524 (29.6%) |
| Active whose card mentions x402 | 7 (0.4%) |
| … with a live x402 402 found at a URL in the card | 0 |
| … … Concordium payTo = on-chain agentWallet | 0 |
| … … Concordium payTo ≠ on-chain agentWallet | 0 |
| … … offering an EVM payTo | 0 |
| … … EVM offer naming a CIS-8 key in `extra` | 0 |

Not checked here: the official badge check (a hosted service), CIS-8 bindings (the registry has no listing by account), endpoints not named in the card or not answering GET.

Run: https://github.com/jiahaoc040-ai/veriflow/actions/runs/45548198450 · code at commit 4fa7b0029feda7c519cedf07425ea0c669aa2dfc · per-agent rows in latest.json
