# VeriFlow

**On-chain exchange-flow signals for AI agents — sold only to verified, eligible buyers, with a track record no one can fake.**

Built for the [Concordium Trusted Agents Hackathon](https://www.encodeclub.com/programmes/concordium-trusted-agents-hackathon) (Encode Club, 2026).

## The problem

1. **Sellers can't comply.** Trading signals are regulated investment information in many jurisdictions. When an agent sells to another agent, the seller has no idea who the buyer is or where they are.
2. **Buyers can't trust.** Signal providers can edit or cherry-pick their history after the fact. A buying agent has no way to check whether a provider's past calls were real.

## How VeriFlow solves it

| Problem | Concordium piece | What it does |
|---|---|---|
| Who is the buyer? | Verify & Access (ZK proofs) | Buyer proves *age ≥ 18* and *country not restricted* — nothing else is revealed |
| Is the seller accountable? | Verified by Concordium badge + Agent Registry (ERC-8004 Agent Card) | VeriFlow is registered and linked to a verified human |
| How does an agent pay? | x402 on Concordium | Pay per signal, fees sponsored |
| How do agents find and call it? | MCP server | Any MCP agent (e.g. Claude) can call `get_signal` |
| Is the track record real? | Commit–reveal on Concordium | Each signal's hash is anchored on-chain **before** the outcome; anyone can recompute it later |

## Status

| Component | State |
|---|---|
| Signal engine (`veriflow/signal.py`) | ✅ works, tested |
| Signal API (`veriflow/api.py`) | ✅ works, tested; returns 402 without gateway |
| Ledger + hit-rate scoring (`veriflow/ledger.py`) | ✅ works, tested |
| On-chain anchoring (`gateway/src/anchor.ts`) | ✅ each paid signal's hash is written to Concordium as `veriflow:v1:<sha256>` (register data, no contract) |
| x402 gateway + self-hosted facilitator (`gateway/`) | ✅ end-to-end testnet payment settled ([tx](https://ccdexplorer.io/testnet/transaction/db37928ff59f3f9ecbaaaf675ba1c8e566677fcec06b76b5af8243169a8848d5)) |
| Verify & Access V1 buyer eligibility (`gateway/src/eligibility.ts`, `/verify`) | ✅ ZK proof of age ≥ 18 + country not restricted, request and audit anchored on-chain ([VRA](https://ccdexplorer.io/testnet/transaction/61e5269537735f09a8234703a0c7c65bf9039b9bc071296b47781b4ec97b4c24), [VAA](https://ccdexplorer.io/testnet/transaction/c4dab99b0d273c3c2ee04a531238a4f5dcc4a0aef0f08db606316d6af72e3e5c)); unverified accounts are refused before payment settles; verified buyer then paid ([payment](https://ccdexplorer.io/testnet/transaction/04a9c9383eb689598ef9068aeaaf97160daf9af50e31e6274483b0792939f8fd), [anchor](https://ccdexplorer.io/testnet/transaction/973eaa16558c5f5f8aeb2c4d6e5804ef8db0271a06de62193432ad613ba68aca)) |
| Agent Registry + Verified by Concordium badge (`gateway/src/registry.ts`) | 🔧 tool ready: registers VeriFlow as a CIS-8004 agent on testnet `<12802,0>` and pins the Agent Card hash |
| MCP server (`gateway/src/mcp.ts`) | ✅ 5 tools over stdio: `get_signal` (pays via x402), `get_track_record`, `list_commitments`, `verify_signal`, `check_eligibility` |
| Dashboard + one-click on-chain verification (`dashboard.py`) | ✅ |

## The signal — and why we publish its track record

The signal is a **risk regime** (`RISK_ON` / `RISK_OFF`) for BTC and ETH, built only from free, public data:

- **Momentum:** trailing 30-day return > 0 (Binance daily closes)
- **Stablecoin liquidity:** 7-day change in total stablecoin supply across all chains, as a 90-day z-score ([DefiLlama](https://defillama.com/stablecoins))
- `RISK_ON` when momentum is positive and liquidity is not clearly contracting (`liquidity_z > -1`)

The design comes from earlier research ([crypto-onchain-factors](https://github.com/jiahaoc040-ai/crypto-onchain-factors)), tested with a train/test split. Momentum's robust out-of-sample effect was **lower drawdown**. An exchange-flow stablecoin factor **broke in early 2023**, possibly because the EVM-only exchange data could not see USDT on Tron; total supply covers every chain. That history is exactly why VeriFlow anchors every signal on-chain: buyers should judge a signal by its verifiable live record, not by a backtest.

*Not investment advice.*

## Commit–reveal

Each signal is serialized to canonical JSON (sorted keys) including a random `nonce`, then hashed with SHA-256. The hash is anchored on Concordium when the signal is issued. Because a signal has only two values, the nonce stops anyone from guessing the signal from its hash before paying. After the 7-day horizon, the full JSON is public and anyone can recompute the hash and check it against the chain.

## Run it

```bash
pip install -r requirements.txt
python -m pytest -q          # offline tests
python scripts/run_signal.py BTC
uvicorn veriflow.api:app --reload    # http://127.0.0.1:8000/docs
```

No API keys are needed for the signal: prices come from Binance and stablecoin supply from DefiLlama.

## Verify it yourself

`streamlit run dashboard.py` shows every commitment with a **one-click verify** button. It reads the transaction back from Concordium, decodes `veriflow:v1:<hash>`, and checks it against the commitment. A buyer can paste the `canonical` signal they received; change a single character and verification fails.

## Agent guardrails

The demo buyer agent only pays in testnet CCD and refuses any single payment above `MAX_PAY_MICROCCD` (default 2 CCD), using x402 client spend controls. A seller that raises its price or switches asset cannot drain the buyer.

## x402 payment gateway (`gateway/`)

No public Concordium x402 facilitator was available, so VeriFlow runs its own with the official `@x402/concordium` package. The facilitator sponsors the transaction fee, so a buyer agent only needs the signal price in CCD.

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

At payment time an x402 `onBeforeVerify` hook reads the payer from the signed transaction (`signedTransaction.header.sender`). An unverified account gets `buyer_proof_required` and a link to `/verify`; its transfer is never broadcast, so it is not charged. The 402 response also advertises the requirement up front in `extra.buyerProof`, following the format proposed in x402 issue #4182.

```bash
cd gateway && npm test      # 15 rule tests: replay, wrong account, identity-only credential, weaker statement, expiry, policy change, payer lookup, …
```

## MCP server — let any agent buy and verify

```bash
cd gateway && npm run mcp      # stdio MCP server
```

| Tool | What it does |
|---|---|
| `get_signal` | Pays ~1 CCD over x402 from `BUYER_KEY_FILE` (refuses more than `MAX_PAY_MICROCCD`) and returns the signal, its commitment and the anchor transaction |
| `get_track_record` | Hit rate of matured signals (free) |
| `list_commitments` | Every commitment with its Concordium transaction (free) |
| `verify_signal` | Reads the anchor back from Concordium; with the `canonical` string, also checks the content hash |
| `check_eligibility` | Has this account passed the ZK eligibility check? Returns the `/verify` link if not |

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "veriflow": {
      "command": "/ABSOLUTE/PATH/veriflow/gateway/node_modules/.bin/tsx",
      "args": ["/ABSOLUTE/PATH/veriflow/gateway/src/mcp.ts"]
    }
  }
}
```

The server reads `gateway/.env` itself, so it works from any working directory. The gateway, facilitator and Python API must be running.

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
