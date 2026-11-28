# VeriFlow

**The trust layer for AI agents that pay each other on Concordium.** Any x402 seller can copy another agent's name, card and badge and put its own wallet in `payTo`; the seller cannot tell who is buying; and nobody can prove what was sold wasn't changed afterwards. In a read-only census of the mainnet Agent Registry, about 1 in 4 Active agents (23.5%) could not be paid safely ([JUDGES.md](JUDGES.md#the-same-checks-across-mainnet)). VeriFlow closes all three, as parts any team can install:

1. **A seller guard any x402 agent can wrap around the client it already has.** Before signing, it reads the seller from the Agent Registry and pays only the agent's own on-chain wallet (or, on Base, a key bound to its owner in CIS-8). Run against seven sellers we do not run: MainsMarker (#990) passed and was bought from, Oracle Scout (#1253) passed and was bought from, x402 Doctor (#5120) passed **on mainnet**, and four were refused, including a seller built to take payment and deliver nothing. See [JUDGES.md](JUDGES.md#the-guard-on-sellers-we-do-not-run).
2. **A seller that checks the buyer**: a zero-knowledge eligibility proof re-checked at every payment, and the payer must be the wallet of the agent it names. Packaged for any x402 seller as [`concordium-x402-seller`](packages/concordium-x402-seller): `concordiumSeller(server, { eligibility, buyerAgent: "optional" })`.
3. **A contract that enforces the payout**: our escrow `veriflow_escrow` `<13171,0>` reads the Agent Registry itself and pays only the `agentWallet` it recorded at payment, while the registry still names it for an Active agent; unknown, Revoked or wallet-less agents are rejected on-chain (codes −2, −3, −4, [CCDScan](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=de8f59574568f62f4fbd7f1675e0220f7a82a1c8029955b6e84ba465b974d159)). Verifiable build ([CCDExplorer](https://ccdexplorer.io/testnet/module/b1b62b091aac44fa10a866224f20bfa213fd5aa5f4a6b77e53d00b5235ff302e)). One click on the live site runs it, no wallet.
4. **A record that cannot be rewritten**: every call our reference seller sells is committed on-chain before its outcome, one per asset and day.

**Ways in, none needing a wallet:** npm (`concordium-x402-guard`, `concordium-x402-seller`), a GitHub Action on the [Marketplace](https://github.com/marketplace/actions/concordium-x402-seller-check) (check a seller in CI, testnet or mainnet; source in [`packages/guard-action`](packages/guard-action)), and the hosted MCP endpoint `https://veriflow-yrhp.onrender.com/mcp` with `check_seller`, listed in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.jiahaoc040-ai/veriflow) as `io.github.jiahaoc040-ai/veriflow`. **No wallet needed:** the [live site](https://veriflow-yrhp.onrender.com) runs a purchase and an escrow payment in one click each, and `npx concordium-x402-guard check <seller-url>` runs the buyer's checks against any x402 seller.

The reference seller sells a deliberately simple public rule: a BTC or ETH `RISK_ON` / `RISK_OFF` call from Binance's 30-day momentum, for 1 testnet CCD, 1 `EUDemo` (Concordium's allow-listed test euro, a Protocol-Level Token, [paid here](https://ccdexplorer.io/testnet/transaction/2faa32b102cb68365f64feef63245f2ef625aeb4a94a7018855ad5aee93866ab)), 1 `hh-VFUSD` (our own PLT test dollar) or 0.01 USDC on Base, over x402. The product is the checks around it.

```ts
import { protect, concordiumGuardDeps } from "concordium-x402-guard"; // npm install concordium-x402-guard
const guarded = protect(client, concordiumGuardDeps({ network: "testnet" })); // wraps your existing @x402/fetch client; "mainnet" works too
const { response, verdict } = await guarded.fetch("https://seller.example/x402/thing", { method: "POST", body });
// verdict.checks: badge · Active in CIS-8004 · official badge check · card hash · payTo bound · (optional) delivery record
```

The package is on npm: <https://www.npmjs.com/package/concordium-x402-guard> (source in [`packages/concordium-x402-guard`](packages/concordium-x402-guard)). Or from a terminal, against any seller: `cd gateway && npm ci && npm run guard -- check <url>` (no wallet), `npm run guard -- buy <url>` (pays only if every check passes).

**Demo video (3 min):** <https://youtu.be/UO6d-opQ56o>

**Judges:** [JUDGES.md](JUDGES.md) is the one-page summary with every on-chain link. **Start here:** [TRY_IT.md](TRY_IT.md). Path A takes about 10 minutes and needs no wallet: check a call that was really bought, against the chain and Binance. Path B takes about 30 minutes: buy one yourself on testnet.

## How Identity, the Agent Registry and payments work together

| Question | Concordium piece | What happens | See it on-chain | What it does not prove |
|---|---|---|---|---|
| **Who is paid?** | Agent Registry (CIS-8004 [`<12802,0>`](https://ccdexplorer.io/testnet/contract/12802/0)), agent **#1313**, Verified by Concordium badge | Before signing, the buyer reads #1313 **straight from a Concordium node**: Active, the Agent Card hash, the owner, and the payout wallet. It pays only if x402 `payTo` equals that wallet. The 402 names the agent in a `concordium-agent` extension, as a pointer only; the wallet always comes from the chain. Any failure means the wallet is never asked to sign. | Wallet bound by [`setAgentWallet` `8238b866…`](https://ccdexplorer.io/testnet/transaction/8238b866de05398d95fd66be64a74b1f0e86279cd2b748838ebaa5fd4e44e33b) to [`3WSAJwTZ…`](https://ccdexplorer.io/testnet/account/3WSAJwTZqVRypnGMkUjW28QDES8h1FUBoCwrzQ1rdN35NGavf8) | A stock x402 client pays `payTo` without asking. The badge's identity check itself is Concordium's hosted service, not on-chain data. |
| **Who may buy?** | Verify & Access V1 | The buyer proves age ≥ 18 and residence outside CU, IR, KP, SY and US, without revealing either. The request (VRA) and audit record (VAA) are anchored. **At every payment** the gateway re-runs the official check on the stored proof. It also requires both anchors to be VeriFlow's own and the credential to still belong to the paying account. Any failure, including a node error, refuses the payment. | Buyer `4Vf4…`: [VRA `edc30fac…`](https://ccdexplorer.io/testnet/transaction/edc30fac188ba167b37e8f7338ce691a0f00932303201230576056e8a103a5d6), [VAA `c40957b4…`](https://ccdexplorer.io/testnet/transaction/c40957b4731064f10103ae7272509cd26a1863ae75746e74f53d8578b4a71e90) | Whether the restricted list is the right one for a given jurisdiction is a legal question. These are testnet identity providers. |
| **What was sold, and when?** | Smart contract v2 [`<13115,0>`](https://ccdexplorer.io/testnet/contract/13115/0) (Rust, this repo) | The contract accepts **one call per asset and day**, and only within the day after that close. Only a committer appointed by the offline owner [`4dNM…`](https://ccdexplorer.io/testnet/account/4dNMXmNKa2i5hvABfbRJ6NebGopaWSPNmMrbvroSzgJF5wjUNt) can commit, and the owner itself cannot. After 7 days anyone can reveal. The contract hashes the text and checks its asset, day, and `RISK_ON ⇔ momentum_e6 > 0`. | Committer [`4HgaCRwX…`](https://ccdexplorer.io/testnet/account/4HgaCRwXHYWLAbHA4NE5LD8Cv8xYvuW4hP6RACaT1xVwT3nmCj) appointed by [`6e3eb548…`](https://ccdexplorer.io/testnet/transaction/6e3eb5483acbcdbf87717649b0941812513220c52b0623cc652c80678dc7668f) | That a call is right. The rule is public and carries no edge. The record shows calls were made before outcomes and never changed. |

**The latest purchase: two agents check each other (2026-11-24).**

1. The buyer, agent **#1478** (badge `JyP9Xd8nPLMb7cZK2y3oq`, owner and `agentWallet` [`4Vf4…`](https://ccdexplorer.io/testnet/account/4Vf4qUg5jWyAJXJ3mR3RHvfu8YXjiNT5asveQFF52FgkjMQ16r), bound by [`setAgentWallet` `e2487e43…`](https://ccdexplorer.io/testnet/transaction/e2487e43d130ac6f5af8ba541978a779e4490f7741086b2115a3f0e3b1484819)), checked the seller, agent #1313, 5/5 from a Concordium node, including `payTo` = #1313's on-chain wallet.
2. The seller checked the buyer back: it read #1478 from a node before verification and again before settlement, and required it to be Active and the payer to be #1478's `agentWallet`.
3. The buyer's Verify & Access proof was re-checked, and it paid 1 CCD: [`515226b5…`](https://ccdexplorer.io/testnet/transaction/515226b587ccb056f3e1c406fe1a85e12382a6a19c61345ef41c821395289b88).
4. It received `{"as_of":"2026-11-23","asset":"BTC","momentum_e6":-242523,…,"signal":"RISK_OFF"}`, committed before the sale in [`d9527398…`](https://ccdexplorer.io/testnet/transaction/d952739813664933795fc43b5d2b4a99a5b0f3455472bad28349628a51f9bd03) under BTC, 2026-11-23 on `<13115,0>`.

**Paid in USDC on Base, still tied to Concordium identity (2026-11-25).** The same signal is also sold for 0.01 USDC on Base Sepolia, and both sides of that payment are bound to Concordium accounts through the **CIS-8 External Key Registry** [`<12801,0>`](https://ccdexplorer.io/testnet/contract/12801/0):

1. The seller's Base address `0xdd31…8746` is registered under #1313's owner `4dNM…` ([`registerExternalKey` `64746743…`](https://ccdexplorer.io/testnet/transaction/64746743a948d0d9dbbc0fafbcb8d9c5ee143fb8dbcf210cb6ebbe50627e59ce)); the buyer's `0xAc02…aCb8` under `4Vf4…` ([`21c76e95…`](https://ccdexplorer.io/testnet/transaction/21c76e955cc356c73e2eb3763b8c9841a01dbb1dd44f08f22b71d20da1162a5b)). Each EVM key signed the CIS-8 canonical bytes, which the contract verified on-chain; our bytes were first compared with the official `build_cis8_canonical_bytes` service.
2. Before signing, the buyer ran the same 5 seller checks, with check 5 replaced: it read CIS-8 from a Concordium node and required `payTo` to be derived from the key in the 402's `extra.cis8`, Active, and bound to #1313's owner.
3. The seller recovered the payer's public key from the EIP-3009 signature itself (no extra header), read CIS-8 from a node, and mapped the payment to Concordium account `4Vf4…`. It then ran the Verify & Access re-check and the #1478 buyer-agent check on that account, and re-read the binding before settlement.
4. Paid 0.01 USDC `0xAc02…` → `0xdd31…`: [`0xe48c3357…`](https://base-sepolia.blockscout.com/tx/0xe48c3357d84601a51ab4caf6db73274b1d57ef797c21c9f54f80f02c875cbc44), settled by the public x402 facilitator. Received the BTC 2026-11-24 call, committed before the sale in [`af3fc90c…`](https://ccdexplorer.io/testnet/transaction/af3fc90c65a4deaa9153431018d0ff083a15705f50181626855fa084ffe14ed8).

An EVM key that is not bound, a revoked binding, an authorization for another payee or amount, a Permit2 payment (not implemented) or a smart-wallet signature (its address is not a key's address, so it cannot be a CIS-8 subject), or an authorization signed by someone other than its `from` is refused before settlement. If the facilitator reports a failure for a transfer that did go through, the gateway reads the Base receipt and delivers only on the exact USDC Transfer. The testnet registry stores keys registered as `secp256k1-uncompressed` in compressed form; the read-back compares both forms. Code: `gateway/src/cis8.ts`, `gateway/src/evm-payer.ts`, `gateway/src/settle-recovery.ts`.

## Next to other agent-identity schemes

Checking who an agent is before paying is not new; where the check sits is what differs. Most schemes sign the *request*; few tie the *payout address* to a registered identity, and none of the three below re-checks the buyer's eligibility at the moment of payment with a zero-knowledge proof. (Concordium's own x402 guide also puts an attribute-proof check in the payment flow, at the facilitator; ours runs in the seller's code at every payment.)

| Scheme | What the other side checks | Trust root | Ties the payment to the identity? |
|---|---|---|---|
| ERC-8004 (Trustless Agents, draft) | Identity NFT, reputation and validation registries; `agentWallet` is a field | Ethereum contracts | No: "Payments are orthogonal to this protocol and not covered here" ([EIP-8004](https://eips.ethereum.org/EIPS/eip-8004)) |
| Visa Trusted Agent Protocol | An RFC 9421 signature on each request, verified with the agent's public key | Visa's agent onboarding | Request, not payout ([spec](https://developer.visa.com/capabilities/trusted-agent-protocol/trusted-agent-protocol-specifications)) |
| Skyfire KYAPay | An ES256 JWT per request carrying the human's and agent's identity claims | Skyfire's JWKS | Token scoped to a seller and amount; claims are disclosed, not proven in zero knowledge ([docs](https://docs.skyfire.xyz/docs/verify-and-extract-data-from-tokens)) |
| **VeriFlow on Concordium** | **Buyer side** (`concordium-x402-guard`): the seller's CIS-8004 record read from a node, its badge, its card hash, and `payTo` = its on-chain `agentWallet`, before signing. **Seller side** (`concordium-x402-seller`): the buyer's Verify & Access proof re-checked at every payment, and a named buyer agent's `agentWallet` = the payer | Concordium's chain and its identity providers | Yes, both ways, enforced by the two parties' own code (not by the facilitator or a contract) |

So the claim is narrow: on Concordium, the payout address and the buyer's proven attributes are checked against the chain inside the x402 payment itself, by the buyer and by the seller.

## Trust in both directions

| Who checks | What | How |
|---|---|---|
| **Seller → buyer** | The paying account's owner is 18+ and not resident in a restricted country | Verify & Access V1 zero-knowledge proof, request and audit anchored on-chain by VeriFlow. The stored proof is re-checked in the gateway's `onBeforeVerify` hook before **every** payment settles. |
| **Buyer → seller** | The agent being paid is identity-verified, Active, its Agent Card is unchanged, and the money goes to **its own on-chain wallet** | Agent #1313 is read straight from a Concordium node (`CIS-8004.agentOf` on `<12802,0>`, `gateway/src/registry-node.ts`). The hosted registry service is used only to resolve the badge and for the official badge check, and its answer must agree with the node. The buyer recomputes the card's SHA-256. x402 `payTo` must equal the on-chain `agentWallet`. The 402's `concordium-agent` extension must name the same agent. |
| **Seller → buyer agent** (optional, `BUYER_AGENT`) | The buyer is itself an agent registered in the Agent Registry, and the payment really comes from that agent | The buyer names its CIS-8004 token id in the `X-Concordium-Agent` header (the 402 advertises the header in `extra.buyerAgentHeader`). In the same `onBeforeVerify` hook the gateway reads that agent from a Concordium node and settles only if it is Active and the **paying account is its on-chain `agentWallet`**. The header is only a pointer: the payment is signed by the payer, so another agent's id cannot be borrowed. A failure refuses the payment before it settles. With `BUYER_AGENT=required` the seller sells only to registered agents. The response carries `buyer_agent` with the id it checked. Code: `gateway/src/buyer-agent.ts`. |

The buyer check runs in an x402 client hook (`onBeforePaymentCreation`, `gateway/src/counterparty.ts`), so a seller that fails it is never even signed for — the wallet is not asked. It fails closed: if the registry is unreachable, the agent does not pay. This stops the impersonation attack where a scam endpoint copies an honest agent's badge and Agent Card but asks to be paid at its own address.

VeriFlow binds its x402 `payTo` to agent #1313 on-chain with `npm run registry -- set-wallet 1313`: the payout account signs the official 162-byte `setAgentWallet` authorization (the command checks every byte — token, owner, wallet, deadline, contract, chain — before signing) and the owner submits it. Done on testnet ([setAgentWallet tx](https://ccdexplorer.io/testnet/transaction/8238b866de05398d95fd66be64a74b1f0e86279cd2b748838ebaa5fd4e44e33b)): agent #1313's `agentWallet` is the x402 payout account `3WSAJwTZ…`. Any buyer agent, not just ours, can then check that paying VeriFlow pays VeriFlow.

## Operations

`/health` reports the API status and the operator account. Since 2026-11-22 that is the committer `4Hga…`, which pays for v1 reveals, eligibility anchors and sponsored buyer fees. The owner `4dNM…` is not on the server: its key is a software key on the developer's machine, used by hand (on mainnet, a hardware wallet). The response is `{"ok":true,"operator":{"account":…,"balance_ccd":…,"low":false}}`. The balance is refreshed every 10 minutes in the background, and `low` turns true below `MIN_OPERATOR_CCD` (default 100). The on-chain state that only the offline owner can change is watched by the `watch` workflow.

## Agent guardrails

The demo buyer agent pays in one asset only, chosen by its own configuration, and refuses any single payment above its cap, using x402 client spend controls: testnet CCD up to `MAX_PAY_MICROCCD` (default 2 CCD) by default; a PLT via `BUYER_PAY_ASSET` up to `BUYER_MAX_PAY`; or, with `BUYER_PAY_NETWORK=evm`, USDC on Base Sepolia up to `BUYER_MAX_PAY` (default 20000 = 0.02 USDC). A seller that raises its price or switches asset cannot drain the buyer. Before signing, it verifies the seller as above (`REQUIRE_SELLER_BADGE=true`).

## x402 payment gateway (`gateway/`)

Payments settle through **Concordium's hosted testnet x402 facilitator** (`FACILITATOR_URL` and an API key in `FACILITATOR_API_KEY`; first settlement [`f0ec0ca6…`](https://ccdexplorer.io/testnet/transaction/f0ec0ca61ce29add3166f10a35e8814108d9da5e730c4256c3f7e6d635d4ed14), fees paid by Concordium's sponsor account). The facilitator sponsors the transaction fee, so a buyer agent only needs the signal price. If it reports a failed settlement with a transaction hash, the gateway checks that transaction on a node itself and delivers only for a finalized, exact payment to `payTo` from the payer. Without a key, the gateway runs its own facilitator from the official `@x402/concordium` package (the diagram below).

```
buyer agent ──GET /signal/BTC──▶ gateway :4020 ──402 + requirements──▶ buyer
buyer signs a sponsored CCD transfer ──▶ gateway ──verify/settle──▶ facilitator :4021 ──▶ Concordium testnet
paid ──▶ gateway ──X-VeriFlow-Gateway secret──▶ Python API :8000 ──▶ signal
```

```bash
cd gateway && npm install
cp .env.example .env                 # fill in key files, SELLER_ADDRESS, GATEWAY_SECRET
npm run facilitator                  # terminal 1
npm run gateway                      # terminal 2 (Python API running on :8000 with the same GATEWAY_SECRET)
npm run buyer -- BTC                 # terminal 3: pays 1 CCD and prints the signal + explorer link
```

## Buyer eligibility (Verify & Access V1)

Before an agent can buy, the person behind its paying account proves once, in the Concordium Wallet, that they are **18+** and **not resident in a restricted country** (`RESTRICTED_COUNTRIES`, default `US,KP,IR,CU,SY`). VeriFlow never sees the birthday or country, only a zero-knowledge proof that the conditions hold.

VeriFlow uses Concordium's official **Verify & Access V1** protocol, so every verification leaves two public, privacy-preserving records on-chain:

```
/verify page ──POST /eligibility/challenge──▶ gateway
   gateway builds the request (age ≥ 18, country ∉ list, one-time nonce, bound to the buyer account)
   and anchors its hash on Concordium ──▶ VRA (Verification Request Anchor), waits for finality
wallet ──requestVerifiablePresentationV1(request)──▶ ZK proof against the anchored request
page ──POST /eligibility/verify──▶ gateway
   cheap checks first: one account credential · statements at least as strict · on-chain IdP · credential belongs to the buyer account
   official SDK check (VerificationAuditRecordV1.createChecked): context matches, proof valid, credential active, request anchored
   pass ──▶ audit record hash anchored ──▶ VAA (Verification Audit Anchor) ──▶ account allowlisted for 30 days
```

At payment time an x402 `onBeforeVerify` hook reads the payer from the signed transaction (`signedTransaction.header.sender`) and re-checks that account's stored proof. The official check is re-run, both anchors must be VeriFlow's, the proof must meet the current policy, and the credential must still belong to the payer. An account that fails gets `buyer_proof_required` and a link to `/verify`. Its transfer is never broadcast, so it is not charged. The 402 response also advertises the requirement up front in `extra.buyerProof`, following the format proposed in x402 issue #4182.

```bash
cd gateway && npm test      # tests: eligibility rules (replay, wrong account, weaker statement, …), seller check, MCP over stdio, contract encoding, verifiers
```

## MCP server — let any agent buy and verify

| Tool | What it does |
|---|---|
| `get_signal` | Pays ~1 CCD over x402 from `BUYER_KEY_FILE` (refuses more than `MAX_PAY_MICROCCD`) and returns the signal, its commitment and the anchor transaction |
| `get_track_record` | Counts of committed and matured calls, and duplicate asset-days (free). No hit rate. |
| `list_commitments` | Every commitment with its Concordium transaction (free) |
| `verify_signal` | Finds the commit transaction through VeriFlow's `/commitments` list, then reads it **from a Concordium node** (our server can hide a commitment, not fake one) and checks: confirmed, carries this commitment, and (with the `canonical` string) the content hashes to it, it was anchored after its data close and within a day of it, and on v2 it sits under its own asset and day |
| `check_eligibility` | Has this account passed the ZK eligibility check? Returns the `/verify` link if not |
| `check_seller` | Without paying, asks the x402 endpoint whom to pay and verifies that seller in the Agent Registry (badge, Active, own card hash, `payTo` = on-chain `agentWallet`). `get_signal` runs the same check and refuses to pay on any failure |

The server also sends MCP `instructions` (check eligibility → judge the track record → verify the seller → buy → verify the signal) and tool annotations (`get_signal` is the only non-read-only tool), so a client knows which call spends money.

**Hosted, nothing to install:** `https://veriflow-yrhp.onrender.com/mcp` (MCP Streamable HTTP, stateless). Add it to any MCP client that supports remote servers — for example as a custom connector in Claude — to get the read-only tools (`get_track_record`, `list_commitments`, `verify_signal`, `check_eligibility`) plus `how_to_buy`, which returns the live x402 terms (network, amount, `payTo`, required buyer proof) without paying. Paying needs the buyer's own wallet, so it happens in the buyer's agent (the local server below, or any x402 client); the hosted server holds nobody's keys. For a check that does not rely on VeriFlow's server: hash the canonical signal you bought (`sha256sum`) and compare it with the `commit` transaction on [CCDExplorer](https://ccdexplorer.io/testnet). The dashboard is a convenience: it recomputes hashes in your browser but reads the chain through VeriFlow's `/onchain` endpoint.

**Claude Desktop, one command** (fills in absolute paths, keeps your other MCP servers, backs up the old config):

```bash
cd gateway && npm run mcp:config -- --install   # buys from the public deployment
# then quit Claude Desktop completely and reopen it: "+" → Connectors → veriflow
```

It checks the buyer key and whether that account has passed eligibility, then writes:

```json
{
  "mcpServers": {
    "veriflow": {
      "command": "/absolute/path/to/node",
      "args": ["--import", "file:///…/gateway/node_modules/tsx/dist/loader.mjs", "/…/gateway/src/mcp.ts"],
      "env": { "GATEWAY_URL": "https://veriflow-yrhp.onrender.com" }
    }
  }
}
```

Absolute paths because Claude Desktop starts servers with a short `PATH` and outside the project folder (`npx`/`tsx` there fail with `ENOENT` or `env: node: No such file or directory`). No secrets go into the config — the server reads `gateway/.env` and `keys/` itself. Use `--local` to point it at a gateway on `localhost:4020`. Logs: `~/Library/Logs/Claude/mcp-server-veriflow.log` (macOS). `test/mcp.test.ts` launches the server exactly this way — from `/`, with a minimal environment — and talks to it over stdio.

## A2A — agent-to-agent

The Agent Card's `url` points to a real A2A JSON-RPC endpoint: `POST https://veriflow-yrhp.onrender.com/a2a` with `message/send` (A2A 0.3.0, stateless). Another agent sends a message — free text like "what is your track record?" / "verify <commitment>" / "is <account> eligible?" / "how do I buy?", or a data part `{"skill": "track_record" | "commitments" | "verify_signal" | "eligibility" | "how_to_buy"}` — and gets back an agent message with a short text answer and the full result as a data part. Like the hosted MCP endpoint it is read-only: paying happens from the buyer's own wallet over x402. The card also lists the hosted MCP endpoint under `services`. The updated card was re-pinned on-chain ([setAgentURI tx](https://ccdexplorer.io/testnet/transaction/300332b588e3c825af7b09c713185fcf101e6921a88571ea3c35f982f5fe4f33)); the official badge check still passes 15/15.

```bash
curl -s https://veriflow-yrhp.onrender.com/a2a -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user","messageId":"1","parts":[{"kind":"text","text":"how do I buy a signal?"}]}}}'
```

## Agent escrow — the payout rule, enforced on-chain (`contract-escrow/`, Rust)

The guard checks the payout address in the buyer's code. The escrow makes the chain check it: a payment is held by `veriflow_escrow`, and the contract itself calls `CIS-8004.agentOf` when the buyer pays and again when the money leaves.

| Entrypoint | Who | Rule |
|---|---|---|
| `pay` (payable) | any account | Rejected unless the agent exists (−2), is Active (−3) and has an `agentWallet` (−4) that is not the buyer (−19). The buyer picks a dispute window, 1 minute to 30 days |
| `release` | the buyer, any time | Pays the `agentWallet` **recorded at payment**, only if the registry still names it for an Active agent: revoked since (−3), re-pointed to another wallet (−22) or not an account (−23) is refused, and the buyer can refund |
| `claim` | the recorded wallet, after the window | Same checks |
| `refund` | the buyer | During the window; afterwards whenever the payout check fails (registry unreadable included); and in any case 30 days after the window, so held CCD is never stuck |
| `escrow`, `view` | anyone | Read-only |

No owner, no upgrade entrypoint, no fee; the registry address is fixed at init. Every failure has its own reject code (−1 … −23, in the order of `Error` in [`src/lib.rs`](contract-escrow/src/lib.rs)). Tests: 5 unit tests and 9 chain tests against a CIS-8004 test double ([`mock-registry/`](contract-escrow/mock-registry)), in CI. The module is a verifiable build (`cargo concordium build --verifiable`, sources published as a release asset, `verify-build` in CI), and CCDExplorer shows it **Verified**.

```bash
cd gateway
npm run escrow -- check 1313             # would the contract accept a payment for agent #1313? (dry run, nothing sent)
npm run escrow -- pay 1313 1 60 "order"  # BUYER_KEY_FILE pays 1 CCD into escrow, 60-minute dispute window
npm run escrow -- release 0              # pays #1313's on-chain agentWallet
```

Live on testnet: `<13171,0>`, module `b1b62b09…`; on the live site, **Pay #1313 through the escrow** runs pay and release with our demo buyer. Transactions: [docs/evidence/escrow-v2-2026-11-27.txt](docs/evidence/escrow-v2-2026-11-27.txt).

v2 follows an outside review (Cursor) of v1 `<13170,0>`, which paid whatever wallet the registry named at payout (an owner could re-point it after a payment), could leave CCD stuck if the registry answer became unreadable, and had no final deadline. v1 is superseded; its transactions: [docs/evidence/escrow-2026-11-27.txt](docs/evidence/escrow-2026-11-27.txt).

## Smart contract v2 — one call per asset and day (`contract-v2/`, Rust)

Deployed on testnet as [`<13115,0>`](https://ccdexplorer.io/testnet/contract/13115/0) from module `08e3b49e…`, which CI built from `5e699ad` ([init `dba400c2…`](https://ccdexplorer.io/testnet/transaction/dba400c20a96eaa1609e5e1f954ac5887aa473785ad5676b3dad99364263a946)). There is no upgrade, delete or replace entrypoint.

| Entrypoint | Who | Rule enforced on-chain |
|---|---|---|
| `commit(asset, as_of, hash)` | the appointed committer only, never the owner or one of its aliases | `asset` is `BTC` or `ETH`. `as_of` is a real `YYYY-MM-DD` date. The block time must be in `[as_of+1d, as_of+2d)` UTC. A second commit for the same `(asset, as_of)`, or a reused hash, is rejected. |
| `reveal(canonical)` | **anyone**, 7 days after the commit | The contract computes SHA-256, finds the slot, and parses the fixed schema. It requires `asset` and `as_of` to equal the key, and `signal` to be `RISK_ON` exactly when `momentum_e6 > 0`. |
| `set_committer`, `revoke_committer` | the owner (not on the server) | Appoints one committer (it replaces the previous one) or removes it. |
| `slot`, `view` | anyone | Read one `(asset, as_of)` slot, or the totals, owner, committer and init time. |

```bash
cd contract-v2 && cargo test --lib          # unit tests; the end-to-end tests run in CI against the compiled Wasm
cd gateway && npm run contract2 -- status   # owner, committer, issued, revealed
```

v1 (`contract/`, `<13094,0>`) keyed commits by hash only, so a second hash for the same day was just another commit. It is retired, and its reveals continue.

## Verified by Concordium

VeriFlow is CIS-8004 agent **#1313** in Concordium's testnet Agent Registry `<12802,0>`. Badge: **`JyP9UWYKh54TD2MUJDfqC`** (`ccd:4221332d34e1694168c2a0c0b3fd0f27/cis-2:JyP9UWYKh54TD2MUJDfqC`).

Anyone can check it without trusting us: read the agent with CIS-8004 `agentOf` (`npx tsx src/registry-node.ts 1313` in `gateway/`), confirm the owner account and `Active` status, then fetch [`agent-card.json`](agent-card.json) and compare its SHA-256 with the on-chain `metadata_hash`. Concordium's hosted checker does all of this: `GET https://agent-registry-mcp.concordium.com/v1/badge-check/JyP9UWYKh54TD2MUJDfqC`.

> ⚠️ `agent-card.json` is hash-pinned on-chain. Editing it breaks the badge until the new hash is pinned with `npm run registry -- set-uri 1313`. `npm test` fails if the file changes, as a reminder.

## Deploy (one container)

The `Dockerfile` runs the Python API, the facilitator and the gateway together; the public port serves the dashboard (`/`), buyer verification (`/verify`), the paid `/signal/{asset}` and the Agent Card (`/.well-known/agent-card.json`). CI builds the image and smoke-tests it against Postgres on every change.

Target: **Render free web service + Neon Postgres**, both free without a card. `render.yaml` is a one-click Blueprint. Render's free plan has 512 MB, so the facilitator runs inside the gateway process; CI runs the container capped at 512 MB. The `keepalive` workflow requests `/health` every 10 minutes so the free instance rarely sleeps; GitHub can delay scheduled runs, so a judge may still occasionally wait for a cold start (about a minute). (Hugging Face Docker Spaces now need a paid plan; the wrapper in `deploy/huggingface/` still works there.)

| Secret / variable | Value |
|---|---|
| `FACILITATOR_KEY_JSON` | contents of the **testnet** sponsor/anchor account `.export` file |
| `SELLER_ADDRESS` | account that receives payments |
| `GATEWAY_SECRET` | any long random string |
| `DATABASE_URL` | Postgres connection string (signals and buyer approvals survive restarts) |
| `PUBLIC_URL` | the deployment's public URL |
| `REGISTRY_CONTRACT` | optional: commit through the Rust contract |

**Hardening for a public URL.** Every `/eligibility/challenge` call anchors a transaction and spends CCD, so it is rate-limited per IP, per account and by a site-wide hourly budget (`CHALLENGES_PER_HOUR`, default 60) that rotating IPs cannot bypass. Pages are served with a strict CSP (inline scripts and styles allowed only by SHA-256 hash, no `unsafe-inline`), CORP/COEP, `no-store`, `nosniff`, `no-referrer` and HSTS. The one deliberate exception: `/verify` allows `unsafe-eval`/`wasm-unsafe-eval`, because the Concordium Browser Wallet injects its SDK into the page's main world and needs them; script sources there are still limited to our own hashed scripts. A passive ZAP baseline of the live site runs weekly and reports no high-risk findings. CI runs Trivy (vulnerable dependencies and committed secrets) on every push; a ZAP baseline scan of the deployed URL can be run from the Actions tab.

The buyer agent's key never goes to the server: agents pay from their own machine (demo buyer or MCP server).

## API

| Method | Path | Access |
|---|---|---|
| GET | `/signal/{asset}` | paid (x402 gateway) |
| GET | `/track-record` | public |
| GET | `/commitments` | public |
| GET | `/commitments/{c}` | public; reveals the full signal after the 7-day horizon |
| GET | `/verify` | public; wallet page for the ZK eligibility proof |
| POST | `/eligibility/challenge`, `/eligibility/verify` | public |
| GET | `/eligibility/{account}` | public; is this account allowed to buy? |
| GET | `/health` | public |
