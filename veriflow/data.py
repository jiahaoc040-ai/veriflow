"""
資料來源（全部免費、不需要 API key）
-----------------------------------
- 穩定幣總供給：DefiLlama Stablecoins API（所有鏈，含 Tron 上的 USDT）
- 價格：Binance 日 K（ccxt）

為什麼不用 Dune：Dune 免費方案已改為「僅瀏覽」，不能用 API，
而產品要能每天自動更新，所以改用免費、公開的 DefiLlama。
"""

from __future__ import annotations

import os

import httpx
import pandas as pd
from dotenv import load_dotenv

load_dotenv()  # 自動讀取專案資料夾裡的 .env（之後放 Concordium 等設定）

LLAMA_STABLES = "https://stablecoins.llama.fi/stablecoincharts/all"
SYMBOLS = {"BTC": "BTC/USDT", "ETH": "ETH/USDT"}


def parse_llama(rows: list[dict]) -> pd.DataFrame:
    """把 DefiLlama 回傳的每日資料轉成 DataFrame(supply_usd)，index = 日期"""
    out = []
    for r in rows:
        usd = r.get("totalCirculatingUSD") or {}
        total = sum(v for v in usd.values() if isinstance(v, (int, float)))
        if total > 0:
            out.append((pd.to_datetime(int(r["date"]), unit="s").normalize(), float(total)))
    df = pd.DataFrame(out, columns=["day", "supply_usd"]).drop_duplicates("day", keep="last")
    return df.set_index("day").sort_index()


def fetch_supply() -> pd.DataFrame:
    """所有穩定幣的每日總流通量（美元計）"""
    r = httpx.get(LLAMA_STABLES, timeout=60)
    r.raise_for_status()
    return parse_llama(r.json())


def fetch_prices(asset: str, since: str = "2020-01-01") -> pd.DataFrame:
    """Binance 日 K 收盤價"""
    import ccxt  # 延後 import：測試時不需要網路

    # 只需要現貨；不載入期貨市場（fapi/dapi 網域在部分地區也會被擋）
    ex = ccxt.binance({"options": {"fetchMarkets": {"types": ["spot"]}}})
    # 雲端主機多在美國，api.binance.com 會擋美國 IP；公開行情可改走官方鏡像 data-api.binance.vision
    public_api = os.environ.get("BINANCE_PUBLIC_API")
    if public_api:
        ex.urls["api"]["public"] = public_api
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
    # 今天（UTC）的日 K 還沒收盤，價格會一直變，不能拿來算訊號
    today = pd.Timestamp.now(tz="UTC").tz_localize(None).normalize()
    return df.loc[df.index < today, ["close"]]
