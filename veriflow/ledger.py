"""
訊號帳本：記錄每個發出的訊號、它的承諾雜湊、上鏈交易，事後計算命中率
-------------------------------------------------------------------
流程（先承諾、後揭露）：
  1. 發訊號時：存下完整內容 + 雜湊，雜湊寫上 Concordium（anchor_tx 先留空）
  2. 之後任何人都能拿公開的訊號內容重算雜湊，對照鏈上紀錄
  3. 評分：RISK_ON 之後 7 天價格上漲 = 命中；RISK_OFF 之後 7 天下跌 = 命中

上鏈的部分（anchor）是下一步：Concordium register data 交易。
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pandas as pd

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


class Ledger:
    def __init__(self, path: str | Path = "veriflow.db"):
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.conn.execute(SCHEMA)

    def record(self, s: Signal) -> str:
        c = s.commitment()
        self.conn.execute(
            "INSERT OR IGNORE INTO signals VALUES (?,?,?,?,?,?,?,NULL)",
            (c, s.asset, s.as_of, s.signal, s.close, s.canonical(), s.issued_at),
        )
        self.conn.commit()
        return c

    def set_anchor(self, commitment: str, tx_hash: str) -> None:
        self.conn.execute("UPDATE signals SET anchor_tx=? WHERE commitment=?", (tx_hash, commitment))
        self.conn.commit()

    def all(self) -> pd.DataFrame:
        return pd.read_sql("SELECT * FROM signals ORDER BY issued_at", self.conn)

    def track_record(self, prices: dict[str, pd.DataFrame]) -> dict:
        """prices：{'BTC': DataFrame(close)}。只評分已經過了 7 天的訊號"""
        df = self.all()
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
            "issued": int(len(df)),
            "scored": n,
            "hit_rate": round(sum(s["hit"] for s in scored) / n, 4) if n else None,
            "horizon_days": HORIZON_DAYS,
            "signals": scored,
        }
