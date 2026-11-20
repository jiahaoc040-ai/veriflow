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

    def track_record(self, prices: dict[str, pd.DataFrame]) -> dict:
        """prices：{'BTC': DataFrame(close)}。只評分已經過了 7 天的訊號

        - 只算有上鏈的訊號：沒上鏈的不能證明是事前發的，不能進績效
        - 同一資產同一收盤日只算一次（取最早上鏈的那筆）：每次付費購買都會產生新的承諾（nonce 不同、
          訊號相同），如果每筆都算，同一天的結果會被重複計分、灌水命中率
        """
        df = self.all()
        issued = int(len(df))
        if not df.empty:
            df = (df[df["anchor_tx"].notna()].sort_values("issued_at", kind="stable")
                  .drop_duplicates(["asset", "as_of"], keep="first"))
        scored = []
        for _, r in df.iterrows():
            p = prices.get(r["asset"])
            if p is None:
                continue
            target = pd.Timestamp(r["as_of"]) + pd.Timedelta(days=HORIZON_DAYS)
            if target not in p.index:
                continue  # 還沒到期
            fwd = p.loc[target, "close"] / r["close"] - 1
            hit = fwd > 0 if r["signal"] == RISK_ON else fwd <= 0
            scored.append({"commitment": r["commitment"], "asset": r["asset"], "as_of": r["as_of"],
                           "signal": r["signal"], "fwd_7d": round(float(fwd), 6), "hit": bool(hit),
                           "anchor_tx": r["anchor_tx"]})
        n = len(scored)
        return {
            "issued": issued,
            "signal_days": int(len(df)),
            "scored": n,
            "hit_rate": round(sum(s["hit"] for s in scored) / n, 4) if n else None,
            "horizon_days": HORIZON_DAYS,
            "signals": scored,
        }
