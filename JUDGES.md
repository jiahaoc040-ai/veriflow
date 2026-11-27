# VeriFlow in one page

**When one AI agent pays another, it cannot tell who it is paying, the seller cannot tell who is buying, and nobody can prove what was sold wasn't changed afterwards. VeriFlow closes all three with Concordium, and every claim on this page is a transaction you can open.**

- **Any x402 agent can check the seller before it signs.** `protect(client)` wraps the `@x402/fetch` client an agent already has: a standalone package on npm, [`concordium-x402-guard`](https://www.npmjs.com/package/concordium-x402-guard) (`npm install concordium-x402-guard`, [source](packages/concordium-x402-guard)), testnet and mainnet. It reads the seller from the Concordium Agent Registry and pays only if the payout address is that agent's own on-chain wallet, or, for a USDC payout on Base, a key bound to the agent's owner in CIS-8. A copycat seller with a stolen card and badge is refused before any signature. **We ran it on seven sellers we do not run** ([below](#the-guard-on-sellers-we-do-not-run)): it passed MainsMarker (#990, another team) and bought from it, passed Oracle Scout (#1253, another team) and bought from it, passed x402 Doctor (#5120) **on mainnet** including its Base payout, and refused four: vet402 and its two test sellers (payout address not the registered wallet; one of them takes payment and returns nothing) and Clear to Pay (no Agent Card on the site).
- **The seller checks the buyer before settling.** A zero-knowledge proof (18+, not in a restricted country, nothing else revealed) is re-checked at every payment, and the payer must be the wallet of the agent it claims to be. Any x402 seller can add the same checks to its own server: [`concordium-x402-seller`](https://www.npmjs.com/package/concordium-x402-seller) ([source](packages/concordium-x402-seller)) attaches them to an `x402ResourceServer` in one call, plus the on-chain recovery of settlements a facilitator misreports and once-only delivery.
- **The chain can enforce the payout too.** Our escrow contract [`<13171,0>`](https://ccdexplorer.io/testnet/contract/13171/0) reads the Agent Registry itself, in the same transaction: a payment to an agent that does not exist, is Revoked, or has no wallet is a rejected transaction, and a payout can only reach the `agentWallet` recorded at payment, and only while the registry still names it. **Try it on the live site, no wallet: "Pay #1313 through the escrow".** Its module is a verifiable build: CCDExplorer shows it **Verified** ("Source and module match"), source included.
- **What was sold cannot be rewritten.** Each call is committed on-chain before its outcome, one per asset per day, under a scoring rule registered before the first commit.

Our own seller is the reference for the last two: it sells a BTC or ETH call, `RISK_ON` or `RISK_OFF`, from Binance's 30-day momentum, for 1 testnet CCD over x402, or 1 `EUDemo` (Concordium's allow-listed test euro, a Protocol-Level Token), or 1 `hh-VFUSD` (a PLT test dollar we issued ourselves), or 0.01 USDC on Base. The rule is deliberately simple and public. The product is the checks around it.

**Demo video (3 min): <https://youtu.be/UO6d-opQ56o>** · Live on testnet: <https://veriflow-yrhp.onrender.com> · Code (MIT): this repo

## Check it in 60 seconds

| Open | You will see | It shows |
|---|---|---|
| [the live site](https://veriflow-yrhp.onrender.com) → **Buy a BTC call** | Our buyer agent #1478, running on the server, checks seller #1313 (each check listed), pays 1 testnet CCD, gets checked back, and your browser then verifies the call against the chain: "Verified" | The whole loop in one click, no wallet. Limited to 20 demo purchases a day (free-tier host: the first load can take about 30 seconds) |
| [the live site](https://veriflow-yrhp.onrender.com) → **Pay #1313 through the escrow** | The contract refuses three agents (read-only calls, codes −3, −4, −2), then a pay and a release transaction, both linked, and the escrow read back: paid to the wallet recorded at payment | The contract, not our server, decides who is paid. Limited to 10 a day |
| [`8800d1cf…`](https://ccdexplorer.io/testnet/transaction/8800d1cfc70a46032a10c6bcf59f5435ab2b6a782fb756875412067830c08580) | Inside one transaction: our escrow calls **`CIS-8004.agentOf`** (parameter `2105…` = agent #1313), then "Transferred Ͼ1.000000 from <13171,0> to 19394" | The payout went to the wallet the contract recorded at payment, because the registry still names it. [Contract](contract-escrow/src/lib.rs), [all transactions](docs/evidence/escrow-v2-2026-11-27.txt) |
| [`240c23b2…`](https://ccdexplorer.io/testnet/transaction/240c23b2a3115a3f0bf090dc1056ffaeb46274f1cd23f27832b6a4f4c4c2cb72) | The same, sent by **19836, an outside tester's own account** on Windows, after he paid in [`15f9ab08…`](https://ccdexplorer.io/testnet/transaction/15f9ab08299926abfd90712ff902403c6cdbc3c18c5e4309b5b7f0746122d573) | Someone other than us used the escrow from TRY_IT.md; his report found a Windows bug, fixed ([evidence](docs/evidence/escrow-v2-2026-11-27.txt)) |
| [`de8f5957…` on CCDScan](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=de8f59574568f62f4fbd7f1675e0220f7a82a1c8029955b6e84ba465b974d159) | "Rejected … `veriflow_escrow.pay` of contract <13171, 0>, **Error code: -4**" | A payment to agent #53, which has no wallet on-chain, refused by the contract (−4 `AgentHasNoWallet`). Same for a Revoked agent, #11: [**−3**](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=a836272e763b98bd1626a6dfcbb61066b929a306224a027eded577565f2248d2) `AgentNotActive`, and an id with no agent: [**−2**](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=fa2b4722eb5a528b1965ae761c557a6924a633bd32604a76727d2a801c95b1be) `AgentNotFound`. No CCD moved in any of them |
| [`1f904fb3…`](https://ccdexplorer.io/testnet/transaction/1f904fb3fbeac7c77891d535c77aec585059447d438a3bd6a9953b8b5b3b4af1) | "Transferred Ͼ1 from 19836 to 19394", sponsor 19003 | A buyer outside the team (account 19836) paid seller agent #1313's wallet (19394); Concordium's facilitator (19003) paid the fee. Their report: [issue #13](https://github.com/jiahaoc040-ai/veriflow/issues/13). |
| [`29ef60c5…` on CCDScan](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=29ef60c50e0a1b1a8103c427c218f3f589b9f9b078982008b983b4a9c1e1c5f2) | "Rejected … `veriflow_registry_v2.commit` of contract <13115, 0>, **Error code: -11**" | Our contract refused a second call for a day that already had one. −11 is `SlotTaken` (the 11th variant of `Error` in [`contract-v2/src/lib.rs`](contract-v2/src/lib.rs)). |
| [`ce062332…` on CCDScan](https://testnet.ccdscan.io/?dcount=1&dentity=transaction&dhash=ce0623322833d6d0d6d5a2891ff7f65ca46b18b45f491483850f4419136047c6) | Same contract, **Error code: -10** | It refused a call sent three days after its close. −10 is `OutsideCommitWindow`. |
| [`ecadec1b…`](https://ccdexplorer.io/testnet/transaction/ecadec1b75cd764a2f87c512787cb3e5422148852760046978e2e4324d8b3271) then [`6e3eb548…`](https://ccdexplorer.io/testnet/transaction/6e3eb5483acbcdbf87717649b0941812513220c52b0623cc652c80678dc7668f) | 2026-11-22 **07:06:10**, then **07:33:20** | The scoring rule was registered before the committer, the only account that can commit, even existed. The first page's data is hex; it decodes to `veriflow:scoring:v2:13115:08e3b49e…:6c862bfe…:babc11e5…` (contract, module, SHA-256 of [SCORING-v2.md](docs/SCORING-v2.md), SHA-256 of [score-v2.ts](gateway/src/score-v2.ts)). |

CCDExplorer does not show a contract's reject code, which is why the rejections link to CCDScan. CCDScan opens the transaction in a panel over its dashboard and can take about 10 seconds to fill it; it shows your local time, CCDExplorer shows UTC.

**Run it yourself, three commands, no wallet** (Node.js 22+, macOS/Linux shell; on Windows see [TRY_IT.md](TRY_IT.md)):

```bash
git clone https://github.com/jiahaoc040-ai/veriflow && cd veriflow/gateway && npm ci
npm run check-call -- '{"as_of":"2026-11-21","asset":"BTC","momentum_e6":-260395,"nonce":"7294f91f41330af85ea8f6af86dc2f9c","signal":"RISK_OFF"}'
#   success: "✅ all checks pass" (the call is in the contract, committed in the day after its close, and Binance gives the same number)
npm run impostor
#   success: four ✓, then "✗ 5. payTo is the agent's on-chain wallet" and "refused before signing: the impostor got nothing"
npm run guard -- check https://mainsmarker.sites.tab.bot/x402/review --json '{"question":"Explain why the sky appears blue during the day.","answer":"Sunlight is scattered by air molecules, and short blue wavelengths scatter far more than red ones (Rayleigh scattering), so blue light reaches us from every direction.","marks":10}'
#   success: six ✓ and "seller verified: agent #990" (another team's seller; nothing is paid)
```

## The guard on sellers we do not run

Run on 2026-11-26 with `npm run guard -- check <url>` or the live site's card (no wallet, pays nothing), and once with `buy`. Output: [checks](docs/evidence/guard-2026-11-26-checks.txt), [purchase](docs/evidence/guard-2026-11-26-buy-mainsmarker.txt), [four more sellers](docs/evidence/guard-2026-11-26-more-sellers.txt).

| Seller (not ours) | Network | Result | Why |
|---|---|---|---|
| MainsMarker, agent #990 (AI answer review) | testnet | **6/6 pass, then bought** | Badge, Active, official check, card hash, `payTo` = its on-chain wallet, and vet402's delivery record says it delivered. Our buyer #1478 paid 0.5 CCD and got the review: [`e8db49aa…`](https://ccdexplorer.io/testnet/transaction/e8db49aae07b4b7a40886ba7d142bbd639b9c047e0856048a1163c377ea301fd) ("Transferred Ͼ0.5 from 19528 to 19330", 19330 = #990's wallet `4J2SFgeV…`; sponsor 19329 is MainsMarker's own facilitator) |
| x402 Doctor, agent #5120 | **mainnet** | **all pass** (that run predates the mainnet default for check 6: it asked vet402 too, which answered "unproven"; check 6 is now off on mainnet unless asked for) | Its Base payout `0x6B0F…5F25` is derived from the external key on its own agent record and bound to its owner `45R4vB9J…` in CIS-8 `<10081,0>`, read from a mainnet node. No payment made |
| vet402, agent #1268 (delivery records) | testnet | **refused at check 5** | Checks 1–4 pass, but its 402 asks to be paid at `3ZXiUAM8…`, while its on-chain `agentWallet` is `3spmVDgX…`. A buyer cannot tell from the chain that the money reaches this agent, so the guard does not pay. This says nothing bad about vet402; it is the check doing its job |
| Oracle Scout, agent #1253 (market evidence packs) | testnet | **6/6 pass** | Badge, Active, official check, card hash, `payTo` = its on-chain wallet `3u319bYk…`; vet402 had no paid requests for it ("unproven", which does not block). **Bought**: 2 CCD, [`d5c6e594…`](https://ccdexplorer.io/testnet/transaction/d5c6e59428f7f3ddf58d929f65a02752dc71759a347c042f97095407a5ccf2db) (2026-11-27, from our #1478's 19528 to its wallet 19515), HTTP 200 with the evidence pack ([output](docs/evidence/guard-2026-11-27-buy-oraclescout.txt)) |
| vet402 S2 and **S3**, run by the vet402 team, not us (S3: "takes 0.01 CCD and … returns an empty body. It does not deliver", in its own 402) | testnet | **both refused at check 5** | Same site as vet402, so the only identity a buyer can read is its card (#1268), and S2/S3 ask to be paid at other accounts (`4iuMKkWL…`, `4not6An1…`). The seller built not to deliver never gets a signature |
| Clear to Pay (escrow pre-clearance) | testnet | **refused at check 1** | Its site serves no `/.well-known/agent-card.json` (HTTP 404), so nothing ties this payment endpoint to the badge its home page shows |

Try it without a terminal: the [live site](https://veriflow-yrhp.onrender.com) has a **Check another team's seller** card that runs the guard on all of these testnet sellers and our own (no payment). In Claude Desktop, the MCP tool `check_any_seller` checks any x402 URL the same way.

Check 6 is optional and comes from another team: vet402's free `/check` tells whether a seller delivered when it was paid. By default only a proven non-delivery blocks; it is off on mainnet because vet402 records testnet only. Try it yourself, no wallet: `cd gateway && npm ci && npm run guard -- check https://mainsmarker.sites.tab.bot/x402/review --json '{"question":"Explain why the sky appears blue during the day.","answer":"Sunlight is scattered by air molecules, and short blue wavelengths scatter far more than red ones (Rayleigh scattering), so blue light reaches us from every direction.","marks":10}'`.

## Who is who

| On the explorer | Is |
|---|---|
| CIS-8004 token `2105000000000000` | Agent **#1313**, the seller. CCDExplorer prints the token id as raw little-endian bytes: `0x21 0x05` = 0x0521 = 1313. |
| Account 19394 (`3WSAJwTZ…`) | #1313's on-chain `agentWallet`: where every payment goes |
| Account 19527 (`4dNMXmNK…`) | #1313's owner. Owns the contract and registered the scoring rule |
| Account 19528 (`4Vf4qUg5…`) | Agent **#1478**, our buyer agent (owner and `agentWallet`) |
| Account 19719 (`4HgaCRwX…`) | The committer: the only account allowed to commit calls. See [keys](#keys-and-roles-stated-plainly) |
| Account 19003 | Concordium's hosted x402 facilitator, which pays the fee on CCD payments |
| VRA / VAA | Verify & Access *request* anchor and *audit* anchor: the two on-chain records of a buyer's zero-knowledge proof. They hold hashes only |
| `<12802,0>` · `<12801,0>` · `<13115,0>` | Agent Registry (CIS-8004) · External Key Registry (CIS-8) · our commit contract v2 |
| "Verification Status: Unverifiable" on `<13115,0>` | CCDExplorer's label for a module that was not built with Concordium's verifiable-build image. The source is [`contract-v2/`](contract-v2/); the module reference `08e3b49e…` is the one the anchored scoring rule names, so a later switch to different code would not match the rule |

## What Concordium does here

| Check | Concordium piece | See it |
|---|---|---|
| **Buyer → seller:** the agent being paid is identity-verified, Active, its card unchanged, and `payTo` is its own wallet | Agent Registry `<12802,0>`, read from a node; Verified by Concordium badge | Wallet bound: [`setAgentWallet` `8238b866…`](https://ccdexplorer.io/testnet/transaction/8238b866de05398d95fd66be64a74b1f0e86279cd2b748838ebaa5fd4e44e33b): token `2105000000000000` (= #1313), new wallet `3WSAJwTZ…` (19394) |
| **Seller → buyer:** 18+ and not resident in a restricted country, nothing else revealed; re-checked at every payment | Verify & Access V1 | Our buyer's proof: [VRA `edc30fac…`](https://ccdexplorer.io/testnet/transaction/edc30fac188ba167b37e8f7338ce691a0f00932303201230576056e8a103a5d6), [VAA `c40957b4…`](https://ccdexplorer.io/testnet/transaction/c40957b4731064f10103ae7272509cd26a1863ae75746e74f53d8578b4a71e90). The age and country are not readable on-chain; the gateway re-checks the stored proof |
| **Seller → buyer agent:** the payer is the wallet of the agent it names, so an agent id cannot be borrowed | Agent Registry, agent #1478 | [`setAgentWallet` `e2487e43…`](https://ccdexplorer.io/testnet/transaction/e2487e43d130ac6f5af8ba541978a779e4490f7741086b2115a3f0e3b1484819): #1478's wallet = 19528 |
| **Cross-chain:** a USDC payment on Base carries Concordium identity on both ends | External Key Registry (CIS-8) `<12801,0>`; the seller recovers the payer's key from its payment signature | Seller's Base key → #1313's owner: [`64746743…`](https://ccdexplorer.io/testnet/transaction/64746743a948d0d9dbbc0fafbcb8d9c5ee143fb8dbcf210cb6ebbe50627e59ce). Buyer's Base key → 19528: [`21c76e95…`](https://ccdexplorer.io/testnet/transaction/21c76e955cc356c73e2eb3763b8c9841a01dbb1dd44f08f22b71d20da1162a5b). Payment, 0.01 USDC `0xAc02…aCb8` → `0xdd31…8746`: [`0xe48c3357…` on Blockscout](https://base-sepolia.blockscout.com/tx/0xe48c3357d84601a51ab4caf6db73274b1d57ef797c21c9f54f80f02c875cbc44) |
| **Stable price in a Protocol-Level Token:** the same call for 1 `EUDemo`, Concordium's test euro with an allow list. Buyer and seller wallet were added to the list by passing Concordium's EU-nationality proof (a zero-knowledge check in the wallet), then the call was paid: [`2faa32b1…`](https://ccdexplorer.io/testnet/transaction/2faa32b102cb68365f64feef63245f2ef625aeb4a94a7018855ad5aee93866ab) (2026-11-27, 1.000000 EUDemo from 19528 to 19394, fee sponsored by Concordium's facilitator 19003). Also payable in 1 `hh-VFUSD`, a test dollar we issued ourselves | PLT `EUDemo` ([token page](https://ccdexplorer.io/testnet/tokens/EUDemo), governance account 15695, allow list); PLT `hh-VFUSD` ([token page](https://ccdexplorer.io/testnet/tokens/hh-VFUSD), 6 decimals; its governance account and almost all of its supply are 19528, our own buyer #1478, so this shows the payment path, not an outside stablecoin); x402 `@x402/concordium` with `price.asset` = the token id; Concordium's facilitator sponsors the fee | Payment [`ed2a9c29…`](https://ccdexplorer.io/testnet/transaction/ed2a9c298d875f7bb0f94aefa9499227304291c9a3f817d34b75416625f22e13): "Transferred 1.000000 from 19528 to 19394, PLT: VeriFlow Test Dollar", sponsor 19003; the buyer got the ETH 2026-11-25 call. The first attempt, [`99310359…`](https://ccdexplorer.io/testnet/transaction/99310359b346f397876aca4298897a4c7f1fce7dfa1ab6dbc947869e0feb5b34), settled on-chain while the facilitator reported "transaction not found", and the seller did not deliver; that is how we found the recovery gap fixed in [`2944a99`](https://github.com/jiahaoc040-ai/veriflow/commit/2944a99) |
| **What was sold, and when:** one call per asset per day, accepted only in the day after the close, revealable after 7 days; on reveal the contract checks the text hashes to the commit and its label agrees with its momentum number | Our Rust contract v2 `<13115,0>` | A commit: [`d9527398…`](https://ccdexplorer.io/testnet/transaction/d952739813664933795fc43b5d2b4a99a5b0f3455472bad28349628a51f9bd03) (parameter: BTC, 2026-11-23, the commitment hash). Rejections: the 60-second table above |
| **Payout enforced by a contract:** money held for an agent is only ever paid to the `agentWallet` recorded at payment, and only while the registry still names it (else −22 and the buyer may refund); unknown, Revoked or wallet-less agents are refused when paid and again at payout; the buyer may refund during a dispute window it chooses, after which the recorded wallet may claim; nothing can stay stuck (refund opens if the payout check fails, and in any case 30 days after the window) | Our Rust contract `veriflow_escrow` `<13171,0>`, which calls the Agent Registry `<12802,0>` (`agentOf`) itself; verifiable build ([module page](https://ccdexplorer.io/testnet/module/b1b62b091aac44fa10a866224f20bfa213fd5aa5f4a6b77e53d00b5235ff302e), source shown). v2 after an outside review of v1 `<13170,0>` ([what changed](docs/evidence/escrow-v2-2026-11-27.txt)) | Pay [`19c00fc2…`](https://ccdexplorer.io/testnet/transaction/19c00fc21e352addd861ccddc8b16c1c4b3d9b466acd9556b8e99c33ce99a737), release [`8800d1cf…`](https://ccdexplorer.io/testnet/transaction/8800d1cfc70a46032a10c6bcf59f5435ab2b6a782fb756875412067830c08580), rejections −4, −3, −2 above, and the site's escrow button. No owner, no upgrade, no fee |
| **Scoring fixed in advance** | Rule hashes as on-chain transaction data | [`ecadec1b…`](https://ccdexplorer.io/testnet/transaction/ecadec1b75cd764a2f87c512787cb3e5422148852760046978e2e4324d8b3271). A public workflow re-checks the hashes and the ordering on every run |

**Reveals and scores:** the [published score report](https://github.com/jiahaoc040-ai/veriflow/tree/score-reports/score-v2) is rebuilt by a scheduled workflow about every 6 hours, so it can be a day behind the live site's newest call; the run's numbers are in that report (GitHub only shows a run's logs to signed-in users). The first v2 calls become revealable on 2026-11-29 (7 days after the first commit) and the first score is published after 2026-11-30. Until then the record shows calls committed before their outcome, not how good they were. This page will link the first reveal and score transactions.

Payments use x402 v2 (`@x402/concordium`). Since 2026-11-24 CCD payments settle through Concordium's hosted testnet facilitator (19003, named in the live 402's `extra.feePayer`). Earlier purchases were settled by VeriFlow's own facilitator, which sponsored the fee from 19719. Base payments settle through the public x402 facilitator.

## Purchases, all of them

Every payment to #1313's wallet (19394) as of 2026-11-26 15:00 UTC, from [its account page](https://ccdexplorer.io/testnet/account/19394): **20 payments of 1 CCD.** The live site's demo button adds to the first row, so the page may show more.

| From | Count | Who |
|---|---|---|
| 19528 | 18 | Our own buyer agent #1478: development, tests and demos. These prove the mechanism, not demand. Purchases from the live site's demo button (since 2026-11-26) also come from #1478 and add to this row |
| 19836 | 1 | A friend of the developer, new to Concordium, on Windows with their own identity and wallet: [`1f904fb3…`](https://ccdexplorer.io/testnet/transaction/1f904fb3fbeac7c77891d535c77aec585059447d438a3bd6a9953b8b5b3b4af1). They told the developer what went wrong during their walkthrough; the fixes are [`a85ad8b`](https://github.com/jiahaoc040-ai/veriflow/commit/a85ad8b) (two bugs, plus clearer Windows steps in TRY_IT.md). Afterwards they filed their own public account, [issue #13](https://github.com/jiahaoc040-ai/veriflow/issues/13), which names the two bugs; the fix commit is 39 minutes older than the issue |
| 19760 | 1 | [`521260c3…`](https://ccdexplorer.io/testnet/transaction/521260c308b99168ca089038aad7d19da3e7de2785c7a218acc05f06bff5d8ed), 2026-11-23: a tester from the hackathon's Discord who answered the developer's request for testers; not our account. The same account works with its own builder's payment contract (`payment_intents` [`<13147,0>`](https://ccdexplorer.io/testnet/contract/13147/0)) |

Plus, from #1478: one USDC purchase on Base, one payment of 1 `EUDemo` ([`2faa32b1…`](https://ccdexplorer.io/testnet/transaction/2faa32b102cb68365f64feef63245f2ef625aeb4a94a7018855ad5aee93866ab)) and two payments of 1 `hh-VFUSD` (one delivered, one paid but not delivered before the fix; both above). In the other direction, our buyer #1478 bought from two other teams' agents, each only after the guard's checks passed: MainsMarker #990 and Oracle Scout #1253 ([above](#the-guard-on-sellers-we-do-not-run)).

## The same checks across mainnet

We ran the buyer's pre-payment checks, read-only, over the whole **mainnet** Agent Registry `<10082,0>` (agents 1–5403, read from a Concordium node on 2026-11-25; [report](https://github.com/jiahaoc040-ai/veriflow/tree/score-reports/census/mainnet), [code](gateway/src/census.ts)):

- **About 1 in 4 Active agents (23.5%) fail the checks a buyer can make before paying.** 4,124 of 5,393 (76.5%) have an on-chain `agentWallet` and an https Agent Card whose SHA-256 equals the on-chain hash. The other 1,269, each counted once: 1,114 have no wallet bound (634 of them also have a card that does not load); of those with a wallet, 31 cards do not load, 68 have no https card, and 56 cards no longer match their pinned hash. Passing is a low bar: all but one of the bound wallets are the owner's own account.
- **Cross-chain identity is already common.** 2,600 Active agents (48%) link an external key; 2,120 (39%) are keys on other chains (Ethereum, NEAR, Solana, Fetch.ai, …), the other 480 are Concordium keys. 2,599 are Active in CIS-8 under the agent's own owner; one could not be read.
- **Paid endpoints are rare.** 322 cards mention x402; one live x402 endpoint is reachable from a card URL (x402 Doctor, #5120, its Base key bound in CIS-8).

What it does not check: the hosted badge service, endpoints not linked from the card. One agent (#839) could not be read in that run (an earlier run the same day read it as Active with a matching card). Testnet: [same report](https://github.com/jiahaoc040-ai/veriflow/tree/score-reports/census/testnet).

## Try more

- **10 minutes, no wallet:** [TRY_IT.md, Path A](TRY_IT.md#path-a-check-a-bought-call-about-10-minutes): hash a bought call, find it on-chain, recompute it from Binance, confirm the rule predates it. Or run `npm run check-call` and paste the call.
- **See a refusal:** `cd gateway && npm ci && npm run impostor` starts a fake seller that copies #1313's card, badge and 402 but swaps `payTo`; the buyer passes 4 checks, fails the 5th, and refuses before signing. Transcripts of every refusal: [docs/EVIDENCE.md](docs/EVIDENCE.md).
- **From Claude Desktop:** the MCP server's `check_seller`, `get_signal` and `verify_signal` tools run the same checks ([README](README.md#mcp-server--let-any-agent-buy-and-verify)).

## Built to fail closed

Tests, run in CI on every push (the contract's whenever it changes): 178 for the gateway (TypeScript), 28 for the guard package, 39 for the seller package, 25 for the Python API and verifier, 10 for the v2 contract and 14 for the escrow contract (Rust).

- A node error, an unreachable registry, a changed card or a revoked binding stops the payment before it settles.
- The buyer's checks run in an x402 client hook, so a failing seller is never signed for.
- When a facilitator reports a failure for a transfer that did go through, the gateway reads the transaction itself (CCD and PLT transfers from a node, USDC from the Base receipt) and delivers only on an exact match of payer, `payTo`, token and amount.
- Details: [THREAT_MODEL.md](docs/THREAT_MODEL.md), [GO_LIVE.md](docs/GO_LIVE.md).

## Keys and roles, stated plainly

- **Owner 19527 (`4dNM…`)** is a software key on the developer's machine, not a hardware wallet (on mainnet it will be: [GO_LIVE.md](docs/GO_LIVE.md#what-changes-for-mainnet)). It did more than setup. Until the committer existed (2026-11-22), VeriFlow's own facilitator signed with this key, so it sponsored buyer fees for the purchases of 2026-11-18 to 11-20 (those transactions show sponsor 19527). It also signed the setup transactions: binding the wallet, the seller's CIS-8 binding `64746743…` (the local key file is still named `keys/facilitator.export`, which is why [EVIDENCE.md](docs/EVIDENCE.md) shows that name), registering the scoring rule and appointing the committer. Since 2026-11-22 the server's key is the committer: the live [`/health`](https://veriflow-yrhp.onrender.com/health) shows its operator account, `4HgaCRwX…`.
- **Committer 19719 (`4Hga…`)** lives on the server and has more than one job on testnet: it commits the daily calls, it sponsored buyer fees for VeriFlow's own facilitator until 2026-11-24, and it signed the two deliberately rejected commits above. The contract limits what it can do: it cannot change the owner or the rule, and the owner can revoke it with `revoke_committer`. On mainnet, committing and fee sponsoring become two accounts.

## What it does not claim

- The signal is a public 30-day momentum rule with no edge. The product is the accountability around it.
- Everything runs on testnet, with testnet identity providers.
- No call has been revealed or scored yet (first reveal 2026-11-29).
- Most purchases are our own agent's (18 of 20 as of 2026-11-26); the other two are a friend of the developer and a tester from the hackathon's Discord.
