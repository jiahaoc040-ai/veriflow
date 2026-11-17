"""
訊號引擎：把每日價格 + 穩定幣總供給變成「風險狀態」訊號
-------------------------------------------------------
  - 動能：過去 30 天報酬 > 0（沿用 crypto-onchain-factors，唯一在測試期穩定有效的是「降低回撤」）
  - 流動性：所有鏈穩定幣總供給的 7 天變化率，取 90 天 z-score

訊號只有兩種：
  RISK_ON  = 動能為正，且穩定幣流動性沒有明顯收縮（liquidity_z > -1）
  RISK_OFF = 其他情況

為什麼用總供給而不是交易所流量：
  先前研究發現交易所流量因子在 2023 年失效，懷疑原因是 Dune cex.flows 只涵蓋 EVM 鏈、
  看不到 Tron 上的 USDT。總供給涵蓋所有鏈，正好避開這個資料盲點。

VeriFlow 賣的是「風險狀態」，不是保證賺錢的預測；鏈上績效紀錄讓買方自己驗證。
"""

from __future__ import annotations

import hashlib
import json
import secrets
from dataclasses import dataclass, asdict
from datetime import datetime, timezone

import numpy as np
import pandas as pd

CHANGE_WINDOW = 7     # 天：供給變化率的視窗
Z_WINDOW = 90         # 天：z-score 的視窗
MOM_LOOKBACK = 30     # 天：動能回看期間
LIQUIDITY_DROP_Z = 1.0  # liquidity_z 低於 -1 視為流動性明顯收縮

RISK_ON = "RISK_ON"
RISK_OFF = "RISK_OFF"


def build_factors(supply: pd.DataFrame, prices: pd.DataFrame) -> pd.DataFrame:
    """
    supply：index = 日期，欄位 supply_usd（穩定幣總供給）
    prices：index = 日期，欄位 close
    回傳每天的 close、momentum、liquidity_z、signal
    """
    d = prices[["close"]].join(supply[["supply_usd"]], how="inner").sort_index()

    growth = d["supply_usd"].pct_change(CHANGE_WINDOW)
    d["liquidity_z"] = (growth - growth.rolling(Z_WINDOW).mean()) / growth.rolling(Z_WINDOW).std()

    d["momentum"] = d["close"].pct_change(MOM_LOOKBACK)

    on = (d["momentum"] > 0) & (d["liquidity_z"] > -LIQUIDITY_DROP_Z)
    d["signal"] = np.where(on, RISK_ON, RISK_OFF)
    # 因子還沒算出來的前幾天不給訊號
    d.loc[d["liquidity_z"].isna() | d["momentum"].isna(), "signal"] = None
    return d


@dataclass
class Signal:
    asset: str          # 例如 "BTC"
    as_of: str          # 訊號依據的資料日期（UTC，YYYY-MM-DD）
    signal: str         # RISK_ON / RISK_OFF
    momentum: float
    liquidity_z: float
    close: float
    issued_at: str      # 訊號發出時間（UTC ISO）
    nonce: str          # 隨機值：避免別人用雜湊反推訊號（只有兩種可能值，不加會被猜出來）

    def canonical(self) -> str:
        """固定格式的 JSON：同一個訊號永遠得到同一個字串，雜湊才能被別人重算"""
        return json.dumps(asdict(self), sort_keys=True, separators=(",", ":"))

    def commitment(self) -> str:
        """要寫上鏈的承諾雜湊（SHA-256）"""
        return hashlib.sha256(self.canonical().encode()).hexdigest()


def latest_signal(asset: str, factors: pd.DataFrame) -> Signal:
    """取最後一個有效日的訊號"""
    valid = factors.dropna(subset=["signal"])
    if valid.empty:
        raise ValueError("資料不足，因子還沒算出來（至少需要約 100 天資料）")
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
    """任何人都能用公開的訊號內容重算雜湊，確認跟鏈上的承諾一致"""
    return hashlib.sha256(signal_json.encode()).hexdigest() == commitment
