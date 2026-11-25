"""
Signal ledger: records each issued signal, its commitment hash and anchor transaction
-------------------------------------------------------------------
Flow (commit first, reveal later):
  1. On issue: store the full content + hash, anchor the hash on Concordium (anchor_tx empty at first)
  2. Afterwards anyone can recompute the hash from the revealed content and compare it with the chain
  3. Scoring is done only by the on-chain rule (docs/SCORING-v2.md, gateway/src/score-v2.ts), not here

Storage: a local SQLite file by default; DATABASE_URL=postgresql://… uses Postgres when deployed (data survives platform restarts).
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd
from sqlalchemy import create_engine, text

from .signal import RISK_ON, Signal

HORIZON_DAYS = 7

SCHEMA = """
CREATE TABLE IF NOT EXISTS signals (
    commitment  TEXT PRIMARY KEY,
    asset       TEXT NOT NULL,
    as_of       TEXT NOT NULL,
    signal      TEXT NOT NULL,
    close       REAL NOT NULL,
    canonical   TEXT NOT NULL,
    issued_at   TEXT NOT NULL,
    anchor_tx   TEXT            -- Concordium transaction hash, filled in once anchored
);
"""


def _engine_url(target: str | Path) -> str:
    """File path → SQLite; postgres:// or postgresql:// → Postgres (psycopg driver)"""
    t = str(target)
    if t.startswith(("postgres://", "postgresql://")):
        return "postgresql+psycopg://" + t.split("://", 1)[1]
    if "://" in t:
        return t
    return f"sqlite:///{t}"


class Ledger:
    def __init__(self, target: str | Path = "veriflow.db"):
        self.engine = create_engine(_engine_url(target), pool_pre_ping=True, future=True)
        with self.engine.begin() as c:
            c.execute(text(SCHEMA))

    def record(self, s: Signal) -> str:
        c = s.commitment()
        with self.engine.begin() as conn:
            conn.execute(
                text(
                    "INSERT INTO signals (commitment, asset, as_of, signal, close, canonical, issued_at, anchor_tx) "
                    "VALUES (:c, :asset, :as_of, :signal, :close, :canonical, :issued_at, NULL) "
                    "ON CONFLICT (commitment) DO NOTHING"
                ),
                {"c": c, "asset": s.asset, "as_of": s.as_of, "signal": s.signal, "close": s.close,
                 "canonical": s.canonical(), "issued_at": s.issued_at},
            )
        return c

    def set_anchor(self, commitment: str, tx_hash: str) -> None:
        with self.engine.begin() as conn:
            conn.execute(text("UPDATE signals SET anchor_tx=:tx WHERE commitment=:c"), {"tx": tx_hash, "c": commitment})

    def get(self, commitment: str) -> dict | None:
        with self.engine.connect() as conn:
            row = conn.execute(text("SELECT * FROM signals WHERE commitment=:c"), {"c": commitment}).mappings().first()
        return dict(row) if row else None

    def for_day(self, asset: str, as_of: str) -> list[dict]:
        """All signals for one asset and close (used by the daily job to avoid duplicates)"""
        with self.engine.connect() as conn:
            rows = conn.execute(
                text("SELECT * FROM signals WHERE asset=:a AND as_of=:d ORDER BY issued_at"), {"a": asset, "d": as_of}
            ).mappings().all()
        return [dict(r) for r in rows]

    def all(self) -> pd.DataFrame:
        with self.engine.connect() as conn:
            return pd.read_sql(text("SELECT * FROM signals ORDER BY issued_at"), conn)

    def track_record(self, prices: dict[str, pd.DataFrame] | None = None, now: pd.Timestamp | None = None) -> dict:
        """Public counts of the record (no scoring)

        Scoring is done only from the chain and Binance by the rule in docs/SCORING.md / docs/SCORING-v2.md (gateway/src/score.ts, score-v2.ts),
        never from this database or its prices; no hit rate is shown here any more.
        - only anchored signals are listed
        - several signals for the same asset and close are not hidden: duplicate_asset_days reports them (the scoring rule counts them as failures)
        The prices parameter is kept only for compatibility with old callers and is unused.
        """
        df = self.all()
        issued = int(len(df))
        anchored = df[df["anchor_tx"].notna()].sort_values("issued_at", kind="stable") if not df.empty else df
        if not anchored.empty:
            # v1 and v2 are different contracts: one each on the same day is not a duplicate; only repeats within one contract count
            anchored = anchored.assign(contract=anchored["canonical"].str.contains('"momentum_e6":', regex=False).map({True: "v2", False: "v1"}))
            days = anchored.groupby(["contract", "asset", "as_of"]).size()
        else:
            days = pd.Series(dtype=int)
        now = now if now is not None else pd.Timestamp.now(tz="UTC").tz_localize(None).normalize()
        signals = [{"commitment": r["commitment"], "asset": r["asset"], "as_of": r["as_of"], "contract": r.get("contract", "v1"),
                    "signal": r["signal"], "anchor_tx": r["anchor_tx"]}
                   for _, r in anchored.iterrows()
                   if pd.Timestamp(r["as_of"]) + pd.Timedelta(days=HORIZON_DAYS + 1) <= now]
        return {
            "issued": issued,
            "signal_days": int(len(days)),
            "duplicate_asset_days": int((days > 1).sum()),
            "matured": len(signals),
            "horizon_days": HORIZON_DAYS,
            "duplicate_asset_days_by_contract": {c: int((days[days.index.get_level_values(0) == c] > 1).sum()) for c in ("v1", "v2")} if len(days) else {"v1": 0, "v2": 0},
            "scoring_rule": "https://github.com/jiahaoc040-ai/veriflow/blob/main/docs/SCORING-v2.md",
            "scoring_rule_v1": "https://github.com/jiahaoc040-ai/veriflow/blob/main/docs/SCORING.md",
            "note": "No hit rate is published. Contract v2 <13115,0> (live since 2026-11-22) is scored by gateway/src/score-v2.ts; the retired v1 <13094,0> by gateway/src/score.ts. Both read only the chain and Binance.",
            "signals": signals,
        }
