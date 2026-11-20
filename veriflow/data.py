"""
資料來源（全部免費、不需要 API key）
-----------------------------------
- 穩定幣總供給：DefiLlama Stablecoins API（所有鏈，含 Tron 上的 USDT）
- 價格：Binance 日 K（公開 /klines 端點）；主機 IP 被 Binance 封鎖時改用 OKX 現貨日 K

為什麼不用 Dune：Dune 免費方案已改為「僅瀏覽」，不能用 API，
而產品要能每天自動更新，所以改用免費、公開的 DefiLlama。
"""

from __future__ import annotations

import os
import time

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


BINANCE_API = "https://api.binance.com/api/v3"


def parse_klines(rows: list[list]) -> pd.DataFrame:
    """Binance /klines 回傳 [開盤時間, 開, 高, 低, 收, 量, ...]；只留尚未收盤以外的日收盤價"""
    df = pd.DataFrame({"ts": [r[0] for r in rows], "close": [float(r[4]) for r in rows]})
    df.index = pd.to_datetime(df["ts"], unit="ms")
    # 今天（UTC）的日 K 還沒收盤，價格會一直變，不能拿來算訊號
    today = pd.Timestamp.now(tz="UTC").tz_localize(None).normalize()
    return df.loc[df.index < today, ["close"]]


def fetch_prices(asset: str, since: str = "2020-01-01") -> pd.DataFrame:
    """Binance 日 K 收盤價（直接呼叫公開 /klines，不用 ccxt）

    以前用 ccxt：它會先下載整個交易所的市場清單（數 MB 的 JSON），
    在 512 MB 的免費主機上和其他請求同時發生時會被 OOM 砍掉。這裡只要一個端點。
    雲端主機多在美國，api.binance.com 會擋美國 IP；可用 BINANCE_PUBLIC_API 改走官方鏡像 data-api.binance.vision。
    """
    symbol = SYMBOLS[asset].replace("/", "")
    start = int(pd.Timestamp(since, tz="UTC").timestamp() * 1000)
    errors = []
    for base in _binance_bases():
        try:
            return parse_klines(_fetch_klines(base, symbol, start))
        except httpx.HTTPError as e:  # 418/451/403：該網域擋這個 IP，換下一個
            errors.append(f"{base}: {str(e).splitlines()[0]}")
    # Binance 會整個封鎖某些雲端主機的 IP（所有網域都回 418）。
    # 備援：OKX 現貨 USDT 日 K（UTC 收盤，和 Binance 同一個時間邊界，收盤價差在萬分之一等級）
    try:
        return parse_klines(_fetch_okx(SYMBOLS[asset].replace("/", "-"), start))
    except (httpx.HTTPError, ValueError) as e:
        errors.append(f"okx: {str(e).splitlines()[0]}")
    raise RuntimeError("all price sources failed: " + " | ".join(errors))


OKX_API = "https://www.okx.com/api/v5/market/history-candles"


def _fetch_okx(inst: str, start: int) -> list[list]:
    """OKX 日 K（bar=1Dutc），新到舊、每頁 100 根；轉成 Binance /klines 的欄位順序，只保留已收盤的"""
    rows: list[list] = []
    after = None
    with httpx.Client(timeout=30, headers=HEADERS) as c:
        while True:
            params = {"instId": inst, "bar": "1Dutc", "limit": 100}
            if after:
                params["after"] = after
            r = c.get(OKX_API, params=params)
            for wait in (1, 2, 4):  # 429：等一下再試同一頁
                if r.status_code != 429:
                    break
                time.sleep(wait)
                r = c.get(OKX_API, params=params)
            r.raise_for_status()
            body = r.json()
            if body.get("code") != "0":
                raise ValueError(f"OKX error {body.get('code')}: {body.get('msg')}")
            page = body["data"]
            if not page:
                break
            for ts, o, h, l, close, vol, *rest in page:
                confirmed = not rest or rest[-1] == "1"
                if int(ts) >= start and confirmed:
                    rows.append([int(ts), o, h, l, close, vol])
            after = page[-1][0]
            if int(after) <= start or len(page) < 100:
                break
            time.sleep(0.12)  # history-candles 限速 20 次 / 2 秒
    rows.sort(key=lambda r: r[0])
    return rows


def _binance_bases() -> list[str]:
    """先用設定的鏡像，再試官方的其他公開網域（各網域的 IP 限制不同）"""
    bases = [os.environ.get("BINANCE_PUBLIC_API"), "https://data-api.binance.vision/api/v3", BINANCE_API,
             "https://api-gcp.binance.com/api/v3", "https://api4.binance.com/api/v3"]
    return list(dict.fromkeys(b for b in bases if b))


HEADERS = {"User-Agent": "VeriFlow/1.0 (+https://github.com/jiahaoc040-ai/veriflow)", "Accept": "application/json"}


def _fetch_klines(base: str, symbol: str, start: int) -> list[list]:
    rows: list[list] = []
    with httpx.Client(timeout=30, headers=HEADERS) as c:
        while True:
            r = c.get(f"{base}/klines", params={"symbol": symbol, "interval": "1d", "startTime": start, "limit": 1000})
            r.raise_for_status()
            batch = r.json()
            rows += batch
            if len(batch) < 1000:
                break
            start = batch[-1][0] + 86_400_000
    return rows
