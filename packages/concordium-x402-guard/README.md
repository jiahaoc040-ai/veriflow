# concordium-x402-guard

Check an x402 seller on Concordium **before your agent pays it**. Wrap the `@x402/fetch` client your agent already uses; any payment it would make is checked first, and if a check fails the wallet is never asked to sign.

```ts
import { x402Client } from "@x402/fetch";
import { protect, concordiumGuardDeps } from "concordium-x402-guard";

const client = x402Client.fromConfig({ schemes: [/* your schemes, as today */] });
const guarded = protect(client, concordiumGuardDeps({ network: "testnet" })); // or "mainnet"

const { response, verdict, error } = await guarded.fetch("https://seller.example/x402/thing", { method: "POST", body });
if (!response) console.log(verdict?.checks); // why it refused, check by check
```

No payment, just a look: `checkSellerAt(url, init, concordiumGuardDeps())` returns the verdict for the seller behind an x402 endpoint.

## What it checks

| # | Check | Read from |
|---|---|---|
| 1 | The site you called advertises a Verified by Concordium badge in its Agent Card | the seller's `/.well-known/agent-card.json` |
| 2 | That badge's agent is registered and **Active** in the CIS-8004 Agent Registry | a Concordium node (the hosted registry service only resolves the badge to a token id; if the two disagree, no payment) |
| 3 | Concordium's official badge check passes (identity-verified owner) | the hosted Agent Registry service |
| 4 | The Agent Card's own SHA-256 equals the hash pinned on-chain | the card URL on-chain, hashed here |
| 5 | `payTo` is the agent's on-chain `agentWallet`; for an EVM `payTo`, a key bound to the agent's owner in the CIS-8 External Key Registry (from the 402's `extra.cis8` or the agent's own `external_reference`) | a Concordium node |
| 6 | Optional, testnet only: an independent delivery record from vet402 (another team's service). By default only a proven non-delivery blocks | `vet402-concordium.fly.dev` |

It fails closed: an unreachable node or registry, a changed card or a revoked binding means no payment. Node reads are retried three times on a dropped connection or a 429.

The site the agent called is the one checked (never the 402's own `resource.url`), and payments started outside `guarded.fetch` are refused.

## Tried on real sellers (2026-11-26)

- MainsMarker, agent #990 (testnet, another team): all checks pass; paid and received the service.
- x402 Doctor, agent #5120 (**mainnet**): all checks pass, including its Base `payTo` bound in CIS-8 through its `external_reference`.
- vet402, agent #1268 (testnet): refused at check 5, because its `payTo` is not its registered wallet.

Output of those runs: <https://github.com/jiahaoc040-ai/veriflow/tree/main/docs/evidence>.

## Networks

| | Agent Registry | CIS-8 | Public node |
|---|---|---|---|
| testnet | `<12802,0>` | `<12801,0>` | `grpc.testnet.concordium.com:20000` |
| mainnet | `<10082,0>` | `<10081,0>` | `grpc.mainnet.concordium.software:20000` |

Pass your own node client with `concordiumGuardDeps({ grpc })` if you run one. Some networks block port 20000; use a phone hotspot or your own node then.

Part of [VeriFlow](https://github.com/jiahaoc040-ai/veriflow) (Concordium Trusted Agents Hackathon). MIT.
