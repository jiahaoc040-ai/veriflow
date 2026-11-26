# concordium-x402-guard

Check an x402 seller on Concordium **before your agent pays it**. Wrap the `@x402/fetch` client your agent already uses; any payment it would make is checked first, and if a check fails the wallet is never asked to sign.

**No code, just a look** (Node 22+, nothing is paid, no wallet):

```bash
npx concordium-x402-guard check https://web-gilt-phi-11.vercel.app/api/packs/rehearsal-btc-150k
npx concordium-x402-guard check https://mainsmarker.sites.tab.bot/x402/review --json '{"question":"Why is the sky blue?","answer":"Rayleigh scattering.","marks":10}'
```

Exit code 0 means every check passed, 1 means refused, 2 means it could not run. Add `--network mainnet` for mainnet agents, `--json-out` for machine-readable output.

**In your agent:**

```bash
npm install concordium-x402-guard @x402/fetch @x402/core @x402/concordium
```

`@x402/fetch` and `@x402/core` are peer dependencies, so the guard wraps the very `x402Client` your agent already has (one copy, your version). `@x402/concordium` is only for the payment scheme in the example below.

The package is **ESM only** and needs Node 22 or newer: use a `.mjs` file or `"type": "module"` in your package.json. `require()` is not supported. In TypeScript, add `@types/node` (the public types use `Buffer`).

```ts
import { x402Client } from "@x402/fetch";
import { ExactConcordiumScheme } from "@x402/concordium/exact/client";
import { protect, concordiumGuardDeps } from "concordium-x402-guard";

const TESTNET = "ccd:4221332d34e1694168c2a0c0b3fd0f27";
// Your client as today: at least one scheme registered for the network you pay on, or no payment can be made at all
const client = x402Client.fromConfig({
  schemes: [{ network: TESTNET, client: new ExactConcordiumScheme({ accountAddress, signer }) }],
  spendControls: { allowedAssets: [{ network: TESTNET, asset: "CCD", maxAmountPerPayment: "2000000" }] },
});
const guarded = protect(client, concordiumGuardDeps({ network: "testnet" })); // or "mainnet"

const { response, verdict, error } = await guarded.fetch("https://seller.example/x402/thing", { method: "POST", body });
if (!response) {
  if (verdict && !verdict.ok) console.log("refused, nothing signed:", verdict.checks); // check by check
  else console.error("request failed before the guard ran:", error); // e.g. no scheme for this network, spend limit
}
```

How a refusal looks: `response` is undefined, `verdict.ok` is false with every check listed, and `error` is also set (x402's "Payment creation aborted: refused to pay: …"). If `verdict` is undefined, the guard never saw a payment (a non-402 answer, or the x402 client failed first). `protect` accepts any `x402Client` from `@x402/fetch`, ESM or CommonJS build.

`network` is the **Concordium** network the checks read: `"testnet"` or `"mainnet"` (default testnet); anything else throws. It also pins what can be paid: a Concordium payment only on that network, an EVM payment only on its Base chain (Base Sepolia for testnet, Base for mainnet). A testnet agent never approves a mainnet payment.

No payment, just a look: `checkSellerAt(url, init, concordiumGuardDeps())` returns the verdict for the seller behind an x402 endpoint. It reads an x402 **v2** 402 (the `PAYMENT-REQUIRED` header); a v1 body-only 402 is not supported there.

## What it checks

| # | Check | Read from |
|---|---|---|
| 1 | The site you called advertises a Verified by Concordium badge in its Agent Card | the seller's `/.well-known/agent-card.json` |
| 2 | That badge's agent is registered and **Active** in the CIS-8004 Agent Registry | a Concordium node (the hosted registry service only resolves the badge to a token id; if the two disagree, no payment) |
| 3 | Concordium's official badge check passes, every sub-check included (identity-verified owner) | the hosted Agent Registry service |
| 4 | The Agent Card's own SHA-256 equals the hash pinned on-chain | the card URL on-chain (https on a public host only, at most 64 KB, no redirects), hashed here |
| 5 | `payTo` is the agent's on-chain `agentWallet` (any alias of that account); for an EVM `payTo`, its key is bound in the CIS-8 External Key Registry to the agent's owner or to its `agentWallet` (key from the 402's `extra.cis8` or the agent's own `external_reference`) | a Concordium node |
| 6 | Optional: an independent delivery record from vet402 (another team's service, testnet only) | `vet402-concordium.fly.dev` |

Checks 1–5 fail closed: an unreachable node or registry, a changed card or a revoked binding means no payment. Reads are retried three times on a dropped connection, a timeout, a 429 or a 5xx.

Check 6 is a third party's opinion, so it is **not** fail-closed by default. `reputation` in the policy (third argument of `protect`) decides:

| mode | blocks when | default |
|---|---|---|
| `"off"` | never (not asked) | mainnet (vet402 records testnet only) |
| `"block-no"` | the record says `no` (proven non-delivery); `unproven` or an unreachable service does not block | testnet |
| `"require-go"` | anything but `go`, including no answer: fail-closed | |
| `"advisory"` | never; the verdict is only reported | |

The site the agent called is the one checked (never the 402's own `resource.url`), and payments started outside `guarded.fetch` are refused.

## Tried on real sellers (2026-11-26)

- MainsMarker, agent #990 (testnet, another team): all checks pass; paid and received the service.
- x402 Doctor, agent #5120 (**mainnet**): all checks pass, including its Base `payTo` bound in CIS-8 through its `external_reference`.
- Oracle Scout, agent #1253 (testnet, another team): all checks pass.
- vet402, agent #1268, and its test sellers S2 and S3 (testnet): refused at check 5, because the `payTo` is not the registered wallet. S3 takes payment and returns nothing.
- Clear to Pay (testnet): refused at check 1, no Agent Card on its site.

Output of those runs: <https://github.com/jiahaoc040-ai/veriflow/tree/main/docs/evidence>.

## Changes

0.2.1: the `npx` command is actually included (0.2.0 was published without it).

0.2.0: `npx concordium-x402-guard check <url>`; `@x402/fetch` and `@x402/core` are peer dependencies; Node 22+ declared; an Agent Card host name that resolves to a private address is refused.

0.1.1: payment network pinned to the configured network; badge sub-checks enforced; Agent Card fetched only from public https hosts and only after the record is confirmed; payTo compared alias-aware; CIS-8 owner compared in code (owner or agentWallet); strict secp256k1 key types; retries see `error.cause`, timeouts and HTTP status; registry responses capped, no redirects; clear error for a wrong `network`; delivery verdicts case-insensitive and capped. Thanks to an outside review for every one of these.

Tests: 28 unit tests (`npm test`, no network: fake registry, node, cards and delivery records), run in CI.

## Networks

| | Agent Registry | CIS-8 | Public node |
|---|---|---|---|
| testnet | `<12802,0>` | `<12801,0>` | `grpc.testnet.concordium.com:20000` |
| mainnet | `<10082,0>` | `<10081,0>` | `grpc.mainnet.concordium.software:20000` |

Pass your own node client with `concordiumGuardDeps({ grpc })` if you run one. Some networks block port 20000; use a phone hotspot or your own node then.

Part of [VeriFlow](https://github.com/jiahaoc040-ai/veriflow) (Concordium Trusted Agents Hackathon). MIT.
