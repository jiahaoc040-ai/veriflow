"""
訊號帳本：記錄每個發出的訊號、它的承諾雜湊、上鏈交易，事後計算命中率
-------------------------------------------------------------------
流程（先承諾、後揭露）：
  1. 發訊號時：存下完整內容 + 雜湊，雜湊寫上 Concordium（anchor_tx 先留空）
  2. 之後任何人都能拿公開的訊號內容重算雜湊，對照鏈上紀錄
  3. 評分：RISK_ON 之後 7 天價格上漲 = 命中；RISK_OFF 之後 7 天下跌 = 命中

儲存：本機預設 SQLite 檔案；部署時設 DATABASE_URL=postgresql://… 改用 Postgres（平台重開資料不會掉）。
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
    anchor_tx   TEXT            -- Concordium 交易 hash，上鏈後填入
);
"""


def _engine_url(target: str | Path) -> str:
    """檔案路徑 → SQLite；postgres:// 或 postgresql:// → Postgres（psycopg 驅動）"""
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
        """某資產某個收盤日的所有訊號（每日自動發訊號用來避免重複）"""
        with self.engine.connect() as conn:
            rows = conn.execute(
                text("SELECT * FROM signals WHERE asset=:a AND as_of=:d ORDER BY issued_at"), {"a": asset, "d": as_of}
            ).mappings().all()
        return [dict(r) for r in rows]

    def all(self) -> pd.DataFrame:
        with self.engine.connect() as conn:
            return pd.read_sql(text("SELECT * FROM signals ORDER BY issued_at"), conn)

    def track_record(self, prices: dict[str, pd.DataFrame] | None = None, now: pd.Timestamp | None = None) -> dict:
        """公開紀錄的計數（不計分）

        計分只由 docs/SCORING.md 的規則與 gateway/src/score.ts 從鏈上與 Binance 計算，
        不用這裡的資料庫或價格；這裡也不再顯示命中率。
        - 只列有上鏈的訊號
        - 同一資產同一收盤日有多筆時不隱藏：duplicate_asset_days 照實回報（計分規則把它算成失敗）
        prices 參數保留只為相容舊呼叫，不使用。
        """
        df = self.all()
        issued = int(len(df))
        anchored = df[df["anchor_tx"].notna()].sort_values("issued_at", kind="stable") if not df.empty else df
        if not anchored.empty:
            # v1 與 v2 是不同合約：同一天各一筆不算重複，只在同一個合約裡重複才算
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
