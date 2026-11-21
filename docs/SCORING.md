# VeriFlow scoring rule v1

This rule was fixed on **2026-11-21**. No outcome existed yet: the earliest call (data close 2026-11-19) resolves at 2026-11-27 00:00 UTC. The SHA-256 of this file and of the script that implements it, `gateway/src/score.ts`, are anchored on Concordium before that time (see [Anchor](#anchor)).

The script has no flags. Its only runtime choices are which Concordium node to ask and where to write the report. Neither can change the result. If this file and the script disagree, the script is the rule, and the disagreement is a bug to report.

## Scope

- Contract `<13094,0>` (`veriflow_registry`) on Concordium testnet (genesis `4221332d…f796`). Its owner `4dNMXmNK…` is the only account that can `commit`.
- Assets: `BTC` and `ETH`.
- A **slot** is one asset on one UTC day. The day is the UTC date of the commit's block time (`committed_at`, stored by the contract).

## Inputs

These are the only inputs. Nothing comes from VeriFlow's API, database, dashboard or price fetcher.

1. **Contract state**, read with any Concordium node's gRPC:
   - `view` for `issued` and the horizon;
   - `commitment(c)` for each commitment's asset, `committed_at` and, after reveal, the revealed text.
2. **Discovery** of which commitments exist: `Committed` events of `<13094,0>` from the CCDScan indexer. This list is accepted only if its count equals the contract's own `issued` counter, and every listed commitment exists in contract state with the same asset. Otherwise the run reports `INCOMPLETE` and publishes no number.
3. **Prices**: Binance spot `BTCUSDT` and `ETHUSDT` daily candles (UTC, interval `1d`), field `close`, from `data-api.binance.vision/api/v3/klines`.
   - Only closed candles are used.
   - A missing candle is a gap. It is never filled from another source.
   - The `close` inside a signal is never used as a price.

## Integrity

The window starts on 2026-11-20, the day the contract was initialised (init tx `590bb53e…`). It ends on the last complete UTC day before the run. No day inside it is skipped.

**Commit integrity** is a fraction.

- The denominator is every slot in the window, plus every commit whose asset is not `BTC` or `ETH`.
- The numerator is the slots with exactly one commit.

These all count as failures:

- a slot with zero commits;
- a slot with two or more commits;
- every commit under a foreign asset label, whether or not it is ever revealed.

**Reveal integrity** is a second fraction. It covers every commit, including duplicates and foreign labels, that is **due**: the run is later than `committed_at` plus the 7-day horizon plus a one-day grace. A due commit passes only if all of the following hold:

- it is revealed on-chain (the contract recomputes SHA-256 at reveal, so the text matches the hash);
- the revealed `asset` equals the asset in the commit;
- the revealed `as_of` is the UTC day before the commit's block day. In other words, the commit was anchored within one day of that data close. A later anchor fails.
- the revealed `signal` equals the published rule applied to the revealed fields: `RISK_ON` exactly when `momentum > 0` and `liquidity_z > -1`.
  - The fields are rounded to 6 decimals when signed.
  - Within `1e-6` of a threshold, either label is accepted.

A due commit that is still unrevealed fails. Only the seller holds the text, so withholding a call is counted against the seller.

Commits that are not yet due are reported as pending. They are neither passes nor failures.

## Performance

The performance window was fixed before any outcome existed. It starts on block day **2026-11-21**. Block day 2026-11-20 holds two commits for BTC and two for ETH. It stays a failure in integrity and is outside the performance window.

**When nothing is published.** No performance number is published if any of the following holds anywhere from 2026-11-21 to the end of the integrity window:

- a slot failure;
- a foreign-asset commit;
- a reveal-integrity failure;
- `INCOMPLETE` discovery.

The report then says why.

**Each call.**

- **Entry**: the close of the first Binance `1d` candle whose close time is strictly after the commit's block time. That is the candle dated the commit's block day. If that candle is missing, the day is a gap. The rule never shifts to a later candle.
- **Exit**: the close of the candle 7 days after the entry candle.
- **Return**: `r = exit / entry − 1`.
- **Position**: `RISK_ON` holds the asset and earns `r`. `RISK_OFF` holds cash and earns `0`.

**Each day.** The book is weight ½ BTC and ½ ETH. The day's return is the average of the two positions.

**Which days count.** A day is scored when both of its calls are revealed and all four candles (entry and exit for each asset) exist.

- Days still waiting for a reveal or an exit candle are pending.
- A day with a missing candle is reported as a gap and not scored.

**Printed every time, over the same scored days:**

| Name | Definition |
|---|---|
| `mean_signal` | mean daily return of the signal book |
| `mean_always_on` | mean daily return of holding both assets every day (always `RISK_ON`) |
| `mean_always_off` | mean daily return of cash every day (always `RISK_OFF`), which is `0` |
| `x_vs_always_on` | `mean_signal − mean_always_on` |
| `x_vs_always_off` | `mean_signal − mean_always_off` |
| counts | scored days, `RISK_OFF` calls, label switches per asset |

The 7-day returns overlap, so consecutive days share most of their window. BTC and ETH also move together. The number of independent observations is far smaller than the number of days, and the report says so in plain words.

**Not computed.** No hit rate, Sharpe ratio, drawdown, annualised return or p-value is computed or published. VeriFlow's `/track-record` endpoint and dashboard stop showing a hit rate. They report counts and link to this rule.

## Running it

```bash
cd gateway && npm ci && npm run score        # prints the report, writes score-report.json
```

The `score` GitHub Actions workflow runs the same command daily and on demand, on GitHub's machines rather than VeriFlow's, and keeps each report as an artifact.

## Anchor

`npm run score -- --spec-hash` prints `sha256(docs/SCORING.md)` and `sha256(gateway/src/score.ts)`. The owner account `4dNMXmNK…` registers the text `veriflow:scoring:v1:<sha256 of SCORING.md>:<sha256 of score.ts>` as transaction data. Anyone can recompute both hashes from the tagged commit and compare them with that transaction on CCDExplorer.
