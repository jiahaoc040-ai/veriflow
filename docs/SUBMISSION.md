# Encode submission text (draft)

For the Concordium Trusted Agents Hackathon form, due 9 Dec 2026 23:59 UTC. Every number and link is in this repo. **Before submitting:** replace "no call has been revealed or scored yet" with the reveal and score transactions (due 29 and 30 Nov), and recount the outside payments.

### (a) One-liner

Trust layer for AI agents paying each other on Concordium: verified sellers, eligible buyers, contract-enforced payouts.

### (b) Project description

When one AI agent pays another over x402, an impostor can copy an honest agent's name, Agent Card and badge and put its own wallet in `payTo`, and a stock x402 client pays it without asking. Sellers, in turn, cannot tell who is buying. In our read-only census of Concordium's mainnet Agent Registry (5,393 Active agents, 2026-11-25), about 1 in 4 (23.5%) could not be paid safely, mostly because no payout wallet is bound on-chain.

VeriFlow closes this with three parts any team can install:

- **Guard (`concordium-x402-guard`):** wraps the `@x402/fetch` client an agent already has. Before signing, it reads the seller from a Concordium node and pays only if `payTo` is that agent's own on-chain `agentWallet` (or, on Base, a key bound to its owner in CIS-8). Against seven sellers we do not run, it passed three (one on mainnet), bought from two, and refused four, including one built to take payment and deliver nothing.
- **Seller (`concordium-x402-seller`):** lets any x402 seller re-check the buyer's Verify & Access zero-knowledge proof (18+, not resident in a restricted country) at every payment and, when the buyer names an agent, require the payer to be that agent's on-chain wallet.
- **Escrow contract (`veriflow_escrow`, `<13171,0>`):** the chain enforces the payout. It reads the Agent Registry itself at payment and at payout, pays only the wallet recorded at payment while the registry still names it, and rejects unknown, Revoked or wallet-less agents. No owner, no upgrade, no fee; verifiable build.

Three ways in, none needing a wallet:

- **npm:** https://www.npmjs.com/package/concordium-x402-guard and https://www.npmjs.com/package/concordium-x402-seller
- **GitHub Marketplace:** the Concordium x402 Seller Check Action checks a seller in CI, on testnet or mainnet: https://github.com/marketplace/actions/concordium-x402-seller-check
- **Official MCP Registry:** listed as `io.github.jiahaoc040-ai/veriflow`, a hosted MCP endpoint whose `check_seller` tool checks any x402 seller before an agent pays: https://registry.modelcontextprotocol.io/v0/servers?search=io.github.jiahaoc040-ai/veriflow

### (c) Concordium features used

- **CIS-8004 Agent Registry** (`<12802,0>` testnet, `<10082,0>` mainnet): the guard reads the seller's record from a Concordium node (Active, owner, Agent Card hash, `agentWallet`) and signs only if x402 `payTo` equals that on-chain wallet, which our seller agent #1313 bound with `setAgentWallet`.
  Tx: https://ccdexplorer.io/testnet/transaction/8238b866de05398d95fd66be64a74b1f0e86279cd2b748838ebaa5fd4e44e33b
- **CIS-8 External Key Registry** (`<12801,0>`): for USDC payments on Base, the seller's payout key and the buyer's paying key are each bound to a Concordium account, so the guard checks the seller's binding before signing and the seller maps the EVM payer back to a Concordium account for its buyer checks.
  Tx (seller's Base key registered under #1313's owner): https://ccdexplorer.io/testnet/transaction/64746743a948d0d9dbbc0fafbcb8d9c5ee143fb8dbcf210cb6ebbe50627e59ce
- **Verify & Access V1:** buyers prove they are 18+ and not resident in a restricted country without revealing either; the request (VRA) and audit record (VAA) are anchored on-chain, and the seller re-checks the stored proof before every payment settles.
  Tx (audit anchor, VAA): https://ccdexplorer.io/testnet/transaction/c40957b4731064f10103ae7272509cd26a1863ae75746e74f53d8578b4a71e90
- **Protocol-Level Tokens (PLT):** the same call is also priced in PLTs through `@x402/concordium` by setting `price.asset` to the token id; our buyer agent paid 1 `EUDemo` (Concordium's allow-listed test euro) after buyer and seller passed its EU-nationality proof, with the fee sponsored by Concordium's facilitator.
  Tx: https://ccdexplorer.io/testnet/transaction/2faa32b102cb68365f64feef63245f2ef625aeb4a94a7018855ad5aee93866ab
- **Smart contracts (Rust):** our escrow `veriflow_escrow` `<13171,0>` calls `CIS-8004.agentOf` itself inside the payout transaction and pays only the wallet recorded at payment (verifiable build), while our commit contract v2 `<13115,0>` accepts one call per asset and day, committed before its outcome.
  Tx (escrow release: `agentOf`, then Ͼ1 to #1313's wallet): https://ccdexplorer.io/testnet/transaction/8800d1cfc70a46032a10c6bcf59f5435ab2b6a782fb756875412067830c08580

### (d) Known limitations and mainnet plan

**Known limitations**

- Everything we run (our seller, the escrow and the commit contract) is on testnet, with testnet identity providers. On mainnet we have only run read-only checks so far: for example, the guard checked x402 Doctor (agent #5120) on 2026-11-26 without paying.
- Little outside use. As of 2026-11-26, 18 of the 20 payments to our seller came from our own buyer agent. Outside the team there are two buyer accounts (a friend of the developer and a tester from the hackathon Discord), and our guard bought from two other teams' agents. We do not claim demand.
- The reference product is a deliberately simple public 30-day momentum call with no edge, and no call has been revealed or scored yet (first reveals 2026-11-29, first score after 2026-11-30).
- Few agents to protect yet: on mainnet, 322 Agent Cards mention x402 and we found one live x402 endpoint. Passing the census is a low bar: all but one of the bound wallets are the owner's own account. Census: https://github.com/jiahaoc040-ai/veriflow/tree/score-reports/census/mainnet
- Buyer eligibility is re-checked on the seller's server from a stored proof and its on-chain anchors. Since 2026-11-27 each re-check is also recorded on-chain, but buyers still rely on the server to run it.
- Fail closed: if the registry cannot be read, the guard does not pay. An outage costs a sale, never money sent to the wrong place.
- Contract v2 shows "Unverifiable" on CCDExplorer because it was built before we used Concordium's verifiable-build image; CI rebuilds it and fails unless the result matches the deployed module. The escrow is Verified.
- On testnet the contract owner is a software key on the developer's machine, and one server key both commits calls and pays for anchoring.
- Stable pricing is shown only with test tokens: `EUDemo` and `hh-VFUSD`, our own test dollar, almost all of whose supply our buyer agent holds. On Base, Permit2 payments are not implemented and smart-wallet signatures are refused.

**Mainnet plan**

- Already usable on mainnet: the guard package, the GitHub Action and the hosted `check_seller` all work against mainnet today. The seller package supports mainnet but needs the seller's own anchoring account for Verify & Access. For mainnet the escrow only needs the mainnet registry `<10082,0>` at init.
- For our own seller (docs/GO_LIVE.md):
  1. Register a new agent in the mainnet registry `<10082,0>` from a mainnet identity, get the badge and bind its wallet.
  2. Contract review, then deploy contract v2 to mainnet as a verifiable build and anchor a new scoring rule before its first commit.
  3. Owner key on a hardware wallet; separate server accounts for committing, anchoring and, if we run our own facilitator, fee sponsoring.
  4. Settlement: we have not seen a hosted mainnet facilitator documented and have asked about one; plan A is our own facilitator, already in the repo. USDC on Base mainnet needs a production facilitator.
  5. Our own node, since Concordium does not run a public hosted gRPC node for production.
  6. Price in the first euro PLT stablecoin with real liquidity (EURR and USDR have been frozen since May 2026), keeping CCD until then; with our own facilitator, each sale costs about Ͼ4–5 in fees, so the price must sit above that.
  7. Legal review before the first mainnet sale.
- Milestones: M0 (Dec 2026) first reveals and first published score; M1 (Q1 2027) contract review, mainnet agent, contract and rule, hardware-wallet owner, done when an agent we do not run makes the first mainnet purchase; M2 (Q1 2027) a buyer pays a fixed stablecoin price on mainnet; M3 (Q2 2027) one agent-platform integration and 10 distinct paying buyer accounts; M4 (Q2 2027) more assets and a 90-day public record.
- Running cost: about Ͼ15,000 a year on-chain for the daily record (roughly $45–75 at the CCD price of 2026-11-26), plus $15–30 a month for hosting and a node at about $40–80 a month. The contract and legal reviews have not been quoted yet, and they, not the chain, set the timeline.
