## Agent Registry census — testnet <12802,0>

Run 2026-11-25T06:51:00.513Z. Read-only: every agent read from a Concordium node (token ids 1–1501, stopping after 300 empty ids), Agent Cards fetched and hashed, x402 endpoints named in cards probed once with GET. No transactions, no payments.

**670 of 1219 Active agents (55%) pass the on-chain checks a buyer can make before paying:** a bound `agentWallet`, and an https Agent Card whose SHA-256 equals the on-chain hash.

| | |
|---|---|
| Agents read | 1501 |
| Active | 1219 (81.2%) |
| Revoked | 282 (18.8%) |
| Could not be decoded | 0 (0%) |
| Active with an on-chain agentWallet | 1042 (85.5%) |
| … of which the wallet is the owner account itself | 1011 (82.9%) |
| Active whose https card loads | 862 (70.7%) |
| Active whose card cannot be loaded | 174 (14.3%) |
| Active with no https card | 181 (14.8%) |
| Active whose card matches the on-chain hash | 803 (65.9%) |
| Active whose card does NOT match the on-chain hash | 58 (4.8%) |
| Active declaring a Verified by Concordium badge in the card | 276 (22.6%) |
| Active linking an external (other-chain) key via external_reference | 241 (19.8%) |
| … key bound in CIS-8 to the agent's owner (read from a node) | 240 (99.6%) |
| … key bound in CIS-8 to a different account | 1 (0.4%) |
| … key not registered in CIS-8 | 0 (0%) |
| … CIS-8 binding revoked | 0 (0%) |
| … points at another contract | 0 (0%) |
| … CIS-8 read failed | 0 (0%) |
| Active whose card mentions x402 | 133 (10.9%) |
| … with a live x402 402 found at a URL in the card | 2 |
| … … Concordium payTo = on-chain agentWallet | 1 |
| … … Concordium payTo ≠ on-chain agentWallet | 1 |
| … … offering an EVM payTo | 0 |
| … … EVM offer naming a CIS-8 key in `extra` | 0 |

Why the other 549 fail, each agent counted once: no agentWallet, and the card also fails 44; no agentWallet, card fine 133; wallet bound but no https card 175; wallet bound but the card does not load 170; wallet bound but the card changed since it was pinned 23.

External key namespaces (Active): `aifleet` 100, `solana:devnet` 30, `concordium` 29, `eip155:1` 18, `fetchai` 10, `eip155:11155111` 6, `cosmos:fetchhub-4` 6, `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` 5, `eip155:8453` 5, `near` 4, `eip155:84532` 4, `solana:mainnet` 3, `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` 3, `solana:5eykt4usfv8p8njdtrepy1vzqkqzkvdp` 2, `eip155:137` 2, `near:testnet` 2, `solana:testnet` 2, `skillmark:v1` 2, `solana` 1, `ccd:4221332d34e1694168c2a0c0b3fd0f27` 1, `fetchai:uagent` 1, `eip155:56` 1, `eip155:43114` 1, `eip155:42161` 1, `eip155:143` 1, `tgtrust:v1` 1.

Not checked here: the official badge check (a hosted service); CIS-8 keys an agent does not link through external_reference (CIS-8 has no listing by account); endpoints not named in the card or not answering GET.

Run: https://github.com/jiahaoc040-ai/veriflow/actions/runs/45562965554 · code at commit 043680f806404dce2f03c628fe97c15fc4f3ba53 · per-agent rows in latest.json

_This README was re-rendered on 2026-11-26 from the same latest.json, with code from main: all namespaces listed, the failures broken down so they add up, and the not-checked list corrected (CIS-8 keys linked through external_reference are checked). No count changed._
