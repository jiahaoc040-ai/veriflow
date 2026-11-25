"""
VeriFlow signal API (FastAPI)
---------------------------
Run: uvicorn veriflow.api:app --reload

Endpoints:
  GET /health            health check
  GET /signal/{asset}    the current signal (behind the x402 payment gateway)
  GET /track-record      public counts of the record (no hit rate; the score comes from the on-chain rule)
  GET /commitments       all commitment hashes and their anchor transactions (public)
  GET /commitments/{c}   one commitment; after 7 days the full content is revealed so anyone can recompute the hash (public)
  POST /commitments/{c}/anchor  the gateway reports the anchor transaction hash (gateway secret only)

Payment protection: the x402 gateway (TypeScript) verifies the payment, then forwards the request with an X-VeriFlow-Gateway header.
The API accepts only requests with the right secret, so nobody can bypass the gateway and get a signal without paying.
"""

from __future__ import annotations

import hmac
import json
import os
import threading
import time

import pandas as pd
from functools import lru_cache

from datetime import datetime, timedelta, timezone

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

from .data import SYMBOLS, fetch_supply, fetch_prices
from .ledger import HORIZON_DAYS, Ledger
from .signal import build_factors, latest_signal

app = FastAPI(title="VeriFlow", version="0.1.0")


@app.on_event("startup")
def _warm_caches():
    """Fetch prices and stablecoin data in the background at startup, so the first visitor (a judge) does not wait 10+ seconds"""
    def warm():
        for a in SYMBOLS:
            try:
                _prices(a)
            except Exception as e:  # noqa: BLE001 — only a warm-up; if it fails, the first request fetches instead
                print(f"warm-up {a} failed: {e}")
        try:
            _supply()
        except Exception as e:  # noqa: BLE001
            print(f"warm-up supply failed: {e}")

    threading.Thread(target=warm, daemon=True).start()
# Deployed: DATABASE_URL (Postgres); locally: a SQLite file
ledger = Ledger(os.environ.get("DATABASE_URL") or os.environ.get("VERIFLOW_DB", "veriflow.db"))
GATEWAY_SECRET = os.environ.get("GATEWAY_SECRET", "")
# Without GATEWAY_SECRET the default is closed: signal and write endpoints refuse everything. Only an explicit VERIFLOW_INSECURE_DEV=1 skips the check (local development)
INSECURE_DEV = os.environ.get("VERIFLOW_INSECURE_DEV") == "1"
# v2: signals are produced and committed to contract v2 by daily-v2; the API only sells the committed one
SIGNAL_VERSION = os.environ.get("SIGNAL_VERSION", "v1")


def _from_gateway(secret: str | None) -> bool:
    if not GATEWAY_SECRET:
        return INSECURE_DEV
    return secret is not None and hmac.compare_digest(secret.encode(), GATEWAY_SECRET.encode())


CACHE_SECONDS = int(os.environ.get("DATA_CACHE_SECONDS", "3600"))


def _hour_bucket() -> int:
    """The cache rolls over every hour: a deployed service stays awake and must not keep the first day's data forever"""
    return int(time.time() // CACHE_SECONDS)


# Fetch the same data only once at a time (warm-up and the first request do not each fetch a copy; the free host has only 512 MB)
_fetch_lock = threading.Lock()


# The signal needs about 100 days (90-day z-score + 7-day change) and the record only recent prices; 400 days is enough,
# no need to refetch everything since 2020 every hour (the OKX fallback returns 100 candles per page, 20+ requests in total, and gets rate-limited)
PRICE_HISTORY_DAYS = int(os.environ.get("PRICE_HISTORY_DAYS", "400"))
_last_good: dict[str, object] = {}


@lru_cache(maxsize=4)
def _prices_cached(asset: str, bucket: int):
    since = (datetime.now(timezone.utc) - timedelta(days=PRICE_HISTORY_DAYS)).strftime("%Y-%m-%d")
    return fetch_prices(asset, since=since)


@lru_cache(maxsize=1)
def _supply_cached(bucket: int):
    return fetch_supply()


def _still_current(df) -> bool:
    """The data already includes yesterday's (UTC) close: no new close arrives today, so reusing it cannot make the signal stale"""
    try:
        yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%d")
        return df.index[-1].strftime("%Y-%m-%d") >= yesterday
    except (AttributeError, IndexError):
        return False


def _prices_at(asset: str, bucket: int):
    with _fetch_lock:
        try:
            df = _prices_cached(asset, bucket)
        except Exception as e:  # noqa: BLE001
            # The hourly refresh failed (the source is blocking us for now): if the data on hand already has yesterday's close, use it — the content is identical
            last = _last_good.get(asset)
            if last is not None and _still_current(last):
                print(f"price refresh {asset} failed, using cached data through {last.index[-1].date()}: {e}")
                return last
            raise
        _last_good[asset] = df
        return df


def _supply_at(bucket: int):
    with _fetch_lock:
        return _supply_cached(bucket)



def _prices(asset: str):
    return _prices_at(asset, _hour_bucket())


def _supply():
    return _supply_at(_hour_bucket())


@app.get("/health")
def health():
    return {"ok": True}


@app.get("/signal/{asset}")
def get_signal(asset: str, x_veriflow_gateway: str | None = Header(default=None)):
    asset = asset.upper()
    if asset not in SYMBOLS:
        raise HTTPException(404, f"unsupported asset: {asset}; available: {list(SYMBOLS)}")
    if not _from_gateway(x_veriflow_gateway):
        raise HTTPException(402, "Payment required: get the signal through the x402 payment gateway")
    if SIGNAL_VERSION == "v2":
        return _v2_signal(asset)
    s = latest_signal(asset, build_factors(_supply(), _prices(asset)))
    # One official signal per asset and close: if today's was already issued (daily job or an earlier buyer), sell the same one and create no new commitment.
    # Otherwise every purchase would add a hash, the record would hold several per day, and nobody could show the seller did not bet both ways.
    rows = ledger.for_day(asset, s.as_of)
    anchored = [r for r in rows if r["anchor_tx"]]
    if anchored or rows:
        r = (anchored or rows)[0]
        out = {"signal": json.loads(r["canonical"]), "canonical": r["canonical"], "commitment": r["commitment"]}
        if r["anchor_tx"]:
            out["anchor_tx"] = r["anchor_tx"]  # already on-chain: the gateway does not anchor it again
        return out
    commitment = ledger.record(s)
    return {"signal": s.__dict__, "canonical": s.canonical(), "commitment": commitment}


def _v2_signal(asset: str) -> dict:
    """v2: sell only yesterday's close call, produced by daily-v2 (GitHub Actions) and already committed to contract v2; no new signal is created here"""
    as_of = (pd.Timestamp.now(tz="UTC").normalize() - pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    rows = [r for r in ledger.for_day(asset, as_of) if '"momentum_e6":' in r["canonical"] and r["anchor_tx"]]
    if not rows:
        raise HTTPException(503, f"The {asset} call for the {as_of} close is not committed on-chain yet. Nothing was charged; try again later.")
    r = rows[0]
    return {"signal": json.loads(r["canonical"]), "canonical": r["canonical"], "commitment": r["commitment"],
            "anchor_tx": r["anchor_tx"], "contract": "v2"}


@app.post("/daily/{asset}")
def daily_signal(asset: str, x_veriflow_gateway: str | None = Header(default=None)):
    """
    Daily public signal (gateway only): at least one anchored signal per asset and close,
    so the record grows every day whether or not anyone buys.
      - an anchored signal for this day exists → {"status": "exists"}, nothing new
      - a signal exists but anchoring failed → return it so the gateway anchors it again
      - neither → issue a new one
    """
    _require_gateway(x_veriflow_gateway)
    if SIGNAL_VERSION == "v2":
        raise HTTPException(410, "v1 daily signals are retired; v2 signals come from the daily-v2 workflow")
    asset = asset.upper()
    if asset not in SYMBOLS:
        raise HTTPException(404, f"unsupported asset: {asset}")
    s = latest_signal(asset, build_factors(_supply(), _prices(asset)))
    rows = ledger.for_day(asset, s.as_of)
    if any(r["anchor_tx"] for r in rows):
        return {"status": "exists", "asset": asset, "as_of": s.as_of}
    if rows:
        r = rows[0]
        return {"status": "retry", "asset": asset, "as_of": s.as_of, "commitment": r["commitment"]}
    commitment = ledger.record(s)
    return {"status": "new", "asset": asset, "as_of": s.as_of, "commitment": commitment}


@app.get("/track-record")
def track_record():
    return ledger.track_record()  # counts only; the score is gateway/src/score.ts (docs/SCORING.md)


@app.get("/commitments")
def commitments():
    all_ = ledger.all()
    df = all_[["commitment", "asset", "as_of", "issued_at", "anchor_tx"]].copy()
    # v2 calls (contract <13115,0>, at most one per asset and day) carry momentum_e6; the rest are from the retired v1
    df["contract"] = all_["canonical"].str.contains('"momentum_e6":', regex=False).map({True: "v2", False: "v1"}) if len(all_) else []
    # Unanchored signals have an empty anchor_tx; pandas makes it NaN, which JSON rejects, so convert it to None
    return df.astype(object).where(df.notna(), None).to_dict("records")


class Anchor(BaseModel):
    anchor_tx: str


def _require_gateway(secret: str | None):
    if not _from_gateway(secret):
        raise HTTPException(403, "only the payment gateway may call this")


@app.post("/commitments/{commitment}/anchor")
def set_anchor(commitment: str, body: Anchor, x_veriflow_gateway: str | None = Header(default=None)):
    _require_gateway(x_veriflow_gateway)
    if not ledger.get(commitment):
        raise HTTPException(404, "commitment not found")
    ledger.set_anchor(commitment, body.anchor_tx)
    return {"ok": True}


@app.get("/commitments/{commitment}")
def get_commitment(commitment: str):
    row = ledger.get(commitment)
    if not row:
        raise HTTPException(404, "commitment not found")
    matured = datetime.now(timezone.utc).date() >= (
        datetime.fromisoformat(row["as_of"]).date() + timedelta(days=HORIZON_DAYS)
    )
    out = {k: row[k] for k in ("commitment", "asset", "as_of", "issued_at", "anchor_tx")}
    out["revealed"] = matured
    if matured:
        # Reveal the full content: sha256(canonical) must equal the commitment, and match the on-chain veriflow:v1:<commitment>
        out["canonical"] = row["canonical"]
    return out
