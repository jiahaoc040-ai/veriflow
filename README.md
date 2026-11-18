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
| On-chain anchoring | ⏳ next |
| x402 gateway + self-hosted facilitator (`gateway/`) | ✅ returns 402 with Concordium payment requirements; end-to-end testnet payment ⏳ |
| Verify & Access | ⏳ |
| Agent Registry + badge | ⏳ |
| MCP server | ⏳ |
| Dashboard | ⏳ |

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

## API

| Method | Path | Access |
|---|---|---|
| GET | `/signal/{asset}` | paid (x402 gateway) |
| GET | `/track-record` | public |
| GET | `/commitments` | public |
| GET | `/health` | public |
