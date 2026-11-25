"""
Data sources (all free, no API key)
-----------------------------------
- Total stablecoin supply: DefiLlama Stablecoins API (all chains, including USDT on Tron)
- Prices: Binance daily candles (public /klines endpoint); OKX spot daily candles when Binance blocks the host IP

Why not Dune: Dune's free plan is now view-only with no API access,
and the product must update itself every day, so it uses the free, public DefiLlama instead.
"""

from __future__ import annotations

import os
import time

import httpx
import pandas as pd
from dotenv import load_dotenv

load_dotenv()  # reads .env in the project folder automatically

LLAMA_STABLES = "https://stablecoins.llama.fi/stablecoincharts/all"
SYMBOLS = {"BTC": "BTC/USDT", "ETH": "ETH/USDT"}


def parse_llama(rows: list[dict]) -> pd.DataFrame:
    """Turn DefiLlama's daily data into a DataFrame(supply_usd) indexed by date"""
    out = []
    for r in rows:
        usd = r.get("totalCirculatingUSD") or {}
        total = sum(v for v in usd.values() if isinstance(v, (int, float)))
        if total > 0:
            out.append((pd.to_datetime(int(r["date"]), unit="s").normalize(), float(total)))
    df = pd.DataFrame(out, columns=["day", "supply_usd"]).drop_duplicates("day", keep="last")
    return df.set_index("day").sort_index()


def fetch_supply() -> pd.DataFrame:
    """Total daily circulating supply of all stablecoins (USD)"""
    r = httpx.get(LLAMA_STABLES, timeout=60)
    r.raise_for_status()
    return parse_llama(r.json())


BINANCE_API = "https://api.binance.com/api/v3"


def parse_klines(rows: list[list]) -> pd.DataFrame:
    """Binance /klines returns [open time, open, high, low, close, volume, ...]; keep daily closes, excluding the candle still open"""
    df = pd.DataFrame({"ts": [r[0] for r in rows], "close": [float(r[4]) for r in rows]})
    df.index = pd.to_datetime(df["ts"], unit="ms")
    # Today's (UTC) candle has not closed; its price keeps moving and must not be used for a signal
    today = pd.Timestamp.now(tz="UTC").tz_localize(None).normalize()
    return df.loc[df.index < today, ["close"]]


def fetch_prices(asset: str, since: str = "2020-01-01") -> pd.DataFrame:
    """Binance daily closes (calls the public /klines directly, no ccxt)

    ccxt used to download the whole exchange's market list (several MB of JSON) first,
    which got OOM-killed on the 512 MB free host when it overlapped other requests. Only one endpoint is needed.
    Cloud hosts are mostly in the US and api.binance.com blocks US IPs; BINANCE_PUBLIC_API can point at the official mirror data-api.binance.vision.
    """
    symbol = SYMBOLS[asset].replace("/", "")
    start = int(pd.Timestamp(since, tz="UTC").timestamp() * 1000)
    errors = []
    for base in _binance_bases():
        try:
            return parse_klines(_fetch_klines(base, symbol, start))
        except httpx.HTTPError as e:  # 418/451/403: this host blocks the IP, try the next
            errors.append(f"{base}: {str(e).splitlines()[0]}")
    # Binance blocks some cloud hosts' IPs entirely (every host returns 418).
    # Fallback: OKX spot USDT daily candles (UTC close, same time boundary as Binance; closes differ by about 0.01%)
    try:
        return parse_klines(_fetch_okx(SYMBOLS[asset].replace("/", "-"), start))
    except (httpx.HTTPError, ValueError) as e:
        errors.append(f"okx: {str(e).splitlines()[0]}")
    raise RuntimeError("all price sources failed: " + " | ".join(errors))


OKX_API = "https://www.okx.com/api/v5/market/history-candles"


def _fetch_okx(inst: str, start: int) -> list[list]:
    """OKX daily candles (bar=1Dutc), newest first, 100 per page; converted to Binance /klines column order, closed candles only"""
    rows: list[list] = []
    after = None
    with httpx.Client(timeout=30, headers=HEADERS) as c:
        while True:
            params = {"instId": inst, "bar": "1Dutc", "limit": 100}
            if after:
                params["after"] = after
            r = c.get(OKX_API, params=params)
            for wait in (1, 2, 4):  # 429: wait and retry the same page
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
            time.sleep(0.12)  # history-candles is limited to 20 requests / 2 s
    rows.sort(key=lambda r: r[0])
    return rows


def _binance_bases() -> list[str]:
    """Try the configured mirror first, then the other official public hosts (each host has different IP limits)"""
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
