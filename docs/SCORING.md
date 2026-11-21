# VeriFlow scoring rule v1

This rule was written on **2026-11-21**. At that point no price outcome existed: the earliest call (data close 2026-11-19) resolves at 2026-11-27 00:00 UTC. One integrity outcome was already known: block day 2026-11-20 has three BTC commits and two ETH commits. The rule therefore does not start any window after that day.

The SHA-256 of this file and of `gateway/src/score.ts`, the script that implements it, are anchored on Concordium before 2026-11-27 00:00 UTC (see [Anchor](#anchor)).

**For contract `<13094,0>` this rule publishes integrity counts and no performance number.** Its first day failed, and the performance window starts on that same day. A performance number can only come from a new contract whose rule is anchored before its first commit and whose window starts on its first day.
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

The performance window starts on the same day as the integrity window, **2026-11-20**. It runs to the end of the integrity window.

**When nothing is published.** No performance number is published if anything in the window blocks it. That covers:
- a slot failure;
- a foreign-asset commit;
- a reveal-integrity failure;
- a day whose exit candle has closed while either of its calls is still unrevealed;
- a missing Binance candle;
- `INCOMPLETE` discovery.

The report lists every blocker. A day is **pending** only while an exit candle is still open. Once both exit candles have closed, the day is either in the mean or blocks it. It is never left out silently. For `<13094,0>`, block day 2026-11-20 blocks the window permanently.

**Each call.**

- **Entry**: the close of the first Binance `1d` candle whose close time is strictly after the commit's block time. That is the candle dated the commit's block day. If that candle is missing, the day blocks publication. The rule never shifts to a later candle.
- **Exit**: the close of the candle 7 days after the entry candle.
- **7-day return**: `r = exit / entry − 1`.
- **Position**: `RISK_ON` holds the asset and earns `r`. `RISK_OFF` holds cash and earns `0`.

**Each day.** The book is weight ½ BTC and ½ ETH. The day's value is the average of the two positions' **7-day** returns. Consecutive days overlap by six of their seven days.

**Printed every time, over the same scored days.** All values are means of overlapping 7-day returns, never daily returns.

| Name | Definition |
|---|---|
| `mean_7d_return_signal` | mean 7-day return of the signal book |
| `mean_7d_return_always_on` | the same for holding both assets every day (always `RISK_ON`) |
| `mean_7d_return_always_off` | the same for cash every day (always `RISK_OFF`), which is `0` |
| `x_vs_always_on` | `mean_7d_return_signal − mean_7d_return_always_on` |
| `x_vs_always_off` | `mean_7d_return_signal − mean_7d_return_always_off` |
| counts | scored days, `RISK_OFF` calls, label switches per asset |

The returns overlap and BTC and ETH move together, so the number of independent observations is far smaller than the number of days. The report says so in plain words.

**Not computed.** No hit rate, Sharpe ratio, drawdown, annualised return or p-value is computed or published. VeriFlow's `/track-record` endpoint and dashboard show counts, including duplicates, and link to this rule.

**Required before any contract publishes a performance number.** This rule checks the revealed `signal` against the revealed `momentum` and `liquidity_z`. It does not recompute those inputs. Until it does, the label is frozen at commit time but is not proven to be the published rule.

The rule for the next contract must recompute both inputs from pinned sources and require each to match the revealed field within `1e-6`, or record a reveal failure:
- `momentum`: the 30-day change in close, from the same Binance candles;
- `liquidity_z`: from one named stablecoin-supply source.

That signal must also be produced from those same sources. A later revision of a source can turn a day into a failure and unpublish the number. It cannot flip a label.

## Running it

```bash
cd gateway && npm ci && npm run score        # prints the report, writes score-report.json
```

The `score` GitHub Actions workflow runs the same command daily and on demand, on GitHub's machines rather than VeriFlow's, and keeps each report as an artifact.

## Anchor

`npm run score -- --spec-hash` prints `sha256(docs/SCORING.md)` and `sha256(gateway/src/score.ts)`. The owner account `4dNMXmNK…` registers the text `veriflow:scoring:v1:<sha256 of SCORING.md>:<sha256 of score.ts>` as transaction data. Anyone can recompute both hashes from the tagged commit and compare them with that transaction on CCDExplorer.
