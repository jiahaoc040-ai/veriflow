"""
Signal engine (v1, retired): turns daily prices + total stablecoin supply into a risk-regime signal
-------------------------------------------------------
  - Momentum: 30-day return > 0 (from crypto-onchain-factors; the only effect that held up out of sample was lower drawdowns)
  - Liquidity: 7-day change of total stablecoin supply across all chains, as a 90-day z-score

Only two signals:
  RISK_ON  = positive momentum and no clear stablecoin liquidity contraction (liquidity_z > -1)
  RISK_OFF = anything else

Why total supply rather than exchange flows:
  earlier research found the exchange-flow factor broke down in 2023, probably because Dune cex.flows covers only EVM chains
  and misses USDT on Tron. Total supply covers every chain, avoiding that blind spot.

VeriFlow sells a risk regime, not a guaranteed prediction; the on-chain record lets buyers check it themselves.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from dataclasses import dataclass, asdict
from datetime import datetime, timezone

import numpy as np
import pandas as pd

CHANGE_WINDOW = 7     # days: window of the supply change
Z_WINDOW = 90         # days: z-score window
MOM_LOOKBACK = 30     # days: momentum lookback
LIQUIDITY_DROP_Z = 1.0  # liquidity_z below -1 counts as a clear liquidity contraction

RISK_ON = "RISK_ON"
RISK_OFF = "RISK_OFF"


def build_factors(supply: pd.DataFrame, prices: pd.DataFrame) -> pd.DataFrame:
    """
    supply: index = date, column supply_usd (total stablecoin supply)
    prices: index = date, column close
    Returns close, momentum, liquidity_z and signal for each day
    """
    d = prices[["close"]].join(supply[["supply_usd"]], how="inner").sort_index()

    growth = d["supply_usd"].pct_change(CHANGE_WINDOW)
    d["liquidity_z"] = (growth - growth.rolling(Z_WINDOW).mean()) / growth.rolling(Z_WINDOW).std()

    d["momentum"] = d["close"].pct_change(MOM_LOOKBACK)

    on = (d["momentum"] > 0) & (d["liquidity_z"] > -LIQUIDITY_DROP_Z)
    d["signal"] = np.where(on, RISK_ON, RISK_OFF)
    # No signal for the first days, before the factors exist
    d.loc[d["liquidity_z"].isna() | d["momentum"].isna(), "signal"] = None
    return d


@dataclass
class Signal:
    asset: str          # e.g. "BTC"
    as_of: str          # date of the data the signal uses (UTC, YYYY-MM-DD)
    signal: str         # RISK_ON / RISK_OFF
    momentum: float
    liquidity_z: float
    close: float
    issued_at: str      # when the signal was issued (UTC ISO)
    nonce: str          # random value: stops anyone from reversing the hash (with only two possible signals it could be guessed)

    def canonical(self) -> str:
        """Fixed-format JSON: the same signal always gives the same string, so anyone can recompute the hash"""
        return json.dumps(asdict(self), sort_keys=True, separators=(",", ":"))

    def commitment(self) -> str:
        """The commitment hash written on-chain (SHA-256)"""
        return hashlib.sha256(self.canonical().encode()).hexdigest()


def latest_signal(asset: str, factors: pd.DataFrame) -> Signal:
    """The signal for the last valid day"""
    valid = factors.dropna(subset=["signal"])
    if valid.empty:
        raise ValueError("not enough data: the factors are not available yet (needs about 100 days of data)")
    row = valid.iloc[-1]
    return Signal(
        asset=asset,
        as_of=valid.index[-1].strftime("%Y-%m-%d"),
        signal=str(row["signal"]),
        momentum=round(float(row["momentum"]), 6),
        liquidity_z=round(float(row["liquidity_z"]), 6),
        close=round(float(row["close"]), 2),
        issued_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        nonce=secrets.token_hex(16),
    )


def verify_commitment(signal_json: str, commitment: str) -> bool:
    """Anyone can recompute the hash from the public signal content and check it against the on-chain commitment"""
    return hashlib.sha256(signal_json.encode()).hexdigest() == commitment
