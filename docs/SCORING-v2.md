# VeriFlow scoring rule v2

This rule scores contract v2 (`contract-v2/`, `veriflow_registry_v2`). Its executable form is `gateway/src/score-v2.ts`.

- **The rule is anchored before the first commit.** The owner account `4dNMXmNK…` registers `veriflow:scoring:v2:<contract index>:<module reference>:<sha256 of this file>:<sha256 of score-v2.ts>` as transaction data, before the contract's first commit.
- **The constants name one deployment.** `contractIndex`, `moduleRef` and `initTx` in the script name exactly one deployment. A different instance or module is a different rule, and this one does not score it.
- **The script has no flags.** The authoritative report is the latest scheduled run of the `score-v2` workflow.
- **Each run checks the anchor.** The run reads the registration transaction (repository variable `SCORING_V2_ANCHOR_TX`) from the chain. It requires all of the following, and otherwise reports `INCOMPLETE`, publishes nothing and fails:
  - the transaction is finalized;
  - it was sent by the contract owner or an alias of it;
  - its text equals the hashes of the files being run;
  - its block time is earlier than the first commit.
  A changed file cannot publish a number.
- **A published number expires.** It is valid until `valid_until`, 26 hours after the run. A later run replaces it. If no later run happens, the number is void; stopping the job cannot leave an old number standing.

## What the contract already enforces

These are enforced by the chain and not re-checked here:

- one commit per `(asset, as_of)`;
- assets `BTC` and `ETH`;
- a commit only while block time is in `[as_of + 1 day, as_of + 2 days)` UTC;
- one committer, never the owner or an alias of the owner (aliases share the first 29 bytes and are compared as one account);
- reveal only after 7 days;
- reveal only of text that hashes to the slot, has the fixed schema and the same `asset` and `as_of`, and whose `signal` is `RISK_ON` exactly when `momentum_e6 > 0`.

## Inputs

These are the only inputs. Nothing comes from VeriFlow's API, database or an indexer.

1. **Contract state**, from any Concordium node:
   - the summary (owner, committer, horizon, `init_time`, `issued`, `revealed`);
   - the per-slot getter for every `(asset, as_of)` from the first required day to yesterday;
   - the instance's source module and the init transaction.
2. **Prices**: Binance spot `BTCUSDT` and `ETHUSDT` `1d` candles, field `close`, from `data-api.binance.vision/api/v3/klines`.
   - Only closed candles are used.
   - A missing candle is never filled from another source.

## Completeness

The run is `INCOMPLETE` and publishes nothing if any of these holds:

- the instance was not created by `initTx`, or does not run `moduleRef`;
- the contract's `issued` counter differs from the number of slots found;
- a slot exists outside the required window (and is not yesterday's open window);
- the horizon is not 7 days.

## Required slots

Every `BTC` and `ETH` slot is required if its `as_of` commit window closes after the contract's `init_time` and no later than the run.

No day inside that range is skipped, and the start is set by the init transaction, not by the first commit.

## Integrity and the recomputed signal

For each required slot, these are failures:

- no commit;
- an exit candle that has closed while the call is still unrevealed;
- a revealed `momentum_e6` that differs from the value recomputed from Binance;
- a Binance candle missing for momentum, entry or exit.

**The recomputation.** It is done in integers, with no tolerance band and no floating point:

- each close is Binance's decimal string, converted exactly to units of `1e-8`;
- `momentum_e6 = round-half-away-from-zero((close(as_of) − close(as_of − 30 calendar days)) × 1,000,000 / close(as_of − 30 calendar days))`;
- `signal = RISK_ON` exactly when `momentum_e6 > 0`.

The contract checks `signal` against the revealed `momentum_e6` at reveal. This rule checks `momentum_e6` against Binance, so a label cannot disagree with the published rule and still count.

The report prints the commit fraction (required slots with a commit) and the reveal fraction (due slots that are revealed and match), together with every failure line.

## Performance

**When it is published.** Only when the run is complete and there is no failure anywhere in the required window. One failed slot blocks the whole number. A day is **pending** only while an exit candle is still open. After that it is either scored or a failure.

**Each call.**

- **Entry**: the close of the `as_of + 1 day` candle, which is the commit's block day.
- **Exit**: the close of the `as_of + 8 days` candle.
- **7-day return**: `r = exit / entry − 1`.
- **Position**: `RISK_ON` holds the asset. `RISK_OFF` holds cash at `0`.

**Each day.** The book is weight ½ BTC and ½ ETH.

**Printed every time, over the same scored days:**

| Name | Definition |
|---|---|
| `mean_7d_return_signal` | mean of the book's overlapping 7-day returns |
| `mean_7d_return_always_on` | the same for always `RISK_ON` |
| `mean_7d_return_always_off` | the same for always `RISK_OFF`, which is `0` |
| `x_vs_always_on` | `mean_7d_return_signal − mean_7d_return_always_on` |
| `x_vs_always_off` | `mean_7d_return_signal − mean_7d_return_always_off` |
| counts | scored days, `RISK_OFF` calls, label switches per asset |

The returns overlap and BTC and ETH move together, so independent observations are far fewer than scored days. The report says so.

**Not computed.** No hit rate, Sharpe ratio, drawdown, annualised return or p-value is computed or published.
