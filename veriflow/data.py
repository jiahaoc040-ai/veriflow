"""
資料來源
--------
- 穩定幣交易所流量：Dune API（query = sql/03_stablecoin_cex_flows.sql）
- 價格：Binance 日 K（ccxt，免 API key）

需要的環境變數（放在 .env）：
  DUNE_API_KEY   你的 Dune API key（dune.com → Settings → API）
  DUNE_QUERY_ID  把 sql/03 存成 Dune query 後，網址列上的數字
"""

from __future__ import annotations

import os

import httpx
import pandas as pd

DUNE_BASE = "https://api.dune.com/api/v1"
SYMBOLS = {"BTC": "BTC/USDT", "ETH": "ETH/USDT"}


def fetch_flows(query_id: str | None = None, api_key: str | None = None) -> pd.DataFrame:
    """抓 Dune query 最近一次執行的結果（不重新執行，省額度）"""
    query_id = query_id or os.environ["DUNE_QUERY_ID"]
    api_key = api_key or os.environ["DUNE_API_KEY"]
    r = httpx.get(
        f"{DUNE_BASE}/query/{query_id}/results",
        headers={"X-Dune-API-Key": api_key},
        params={"limit": 5000},
        timeout=60,
    )
    r.raise_for_status()
    rows = r.json()["result"]["rows"]
    df = pd.DataFrame(rows)
    df["day"] = pd.to_datetime(df["day"]).dt.tz_localize(None).dt.normalize()
    return df.set_index("day")[["inflow_usd", "outflow_usd"]].astype(float).sort_index()


def refresh_flows(query_id: str | None = None, api_key: str | None = None) -> str:
    """讓 Dune 重新執行 query（每天一次就夠，會花額度），回傳 execution_id"""
    query_id = query_id or os.environ["DUNE_QUERY_ID"]
    api_key = api_key or os.environ["DUNE_API_KEY"]
    r = httpx.post(
        f"{DUNE_BASE}/query/{query_id}/execute",
        headers={"X-Dune-API-Key": api_key},
        timeout=60,
    )
    r.raise_for_status()
    return r.json()["execution_id"]


def fetch_prices(asset: str, since: str = "2020-01-01") -> pd.DataFrame:
    """Binance 日 K 收盤價"""
    import ccxt  # 延後 import：測試時不需要網路

    ex = ccxt.binance()
    since_ms = ex.parse8601(f"{since}T00:00:00Z")
    out = []
    while True:
        batch = ex.fetch_ohlcv(SYMBOLS[asset], "1d", since=since_ms, limit=1000)
        if not batch:
            break
        out += batch
        since_ms = batch[-1][0] + 86_400_000
        if len(batch) < 1000:
            break
    df = pd.DataFrame(out, columns=["ts", "open", "high", "low", "close", "volume"])
    df.index = pd.to_datetime(df["ts"], unit="ms")
    return df[["close"]]
