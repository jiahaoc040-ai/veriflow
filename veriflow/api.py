"""
VeriFlow 訊號 API（FastAPI）
---------------------------
執行：uvicorn veriflow.api:app --reload

端點：
  GET /health            健康檢查
  GET /signal/{asset}    取得最新訊號（之後由 x402 付款關卡保護）
  GET /track-record      命中率與所有已評分訊號（公開）
  GET /commitments       所有承諾雜湊與上鏈交易（公開）
  GET /commitments/{c}   單一承諾；滿 7 天後揭露完整內容，任何人可重算雜湊（公開）
  POST /commitments/{c}/anchor  付款關卡回報上鏈交易 hash（只接受關卡密鑰）

付款保護：x402 關卡（TypeScript）驗證付款後，帶著 X-VeriFlow-Gateway 標頭轉發過來。
API 只接受帶正確密鑰的請求，所以沒付款的人無法繞過關卡直接拿訊號。
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
    """啟動後在背景先抓價格與穩定幣資料，第一個訪客（評審）不用等 10 秒以上"""
    def warm():
        for a in SYMBOLS:
            try:
                _prices(a)
            except Exception as e:  # noqa: BLE001 — 只是預熱，失敗就等第一次請求再抓
                print(f"warm-up {a} failed: {e}")
        try:
            _supply()
        except Exception as e:  # noqa: BLE001
            print(f"warm-up supply failed: {e}")

    threading.Thread(target=warm, daemon=True).start()
# 部署時設 DATABASE_URL（Postgres），本機預設 SQLite 檔案
ledger = Ledger(os.environ.get("DATABASE_URL") or os.environ.get("VERIFLOW_DB", "veriflow.db"))
GATEWAY_SECRET = os.environ.get("GATEWAY_SECRET", "")
# 沒設 GATEWAY_SECRET 時預設「關閉」：訊號與寫入端點一律拒絕。只有明確設 VERIFLOW_INSECURE_DEV=1 才不檢查（本機開發用）
INSECURE_DEV = os.environ.get("VERIFLOW_INSECURE_DEV") == "1"
# v2：訊號由 daily-v2 產生並上鏈到合約 v2；API 只賣已上鏈的那一筆
SIGNAL_VERSION = os.environ.get("SIGNAL_VERSION", "v1")


def _from_gateway(secret: str | None) -> bool:
    if not GATEWAY_SECRET:
        return INSECURE_DEV
    return secret is not None and hmac.compare_digest(secret.encode(), GATEWAY_SECRET.encode())


CACHE_SECONDS = int(os.environ.get("DATA_CACHE_SECONDS", "3600"))


def _hour_bucket() -> int:
    """快取每小時換一次：部署後服務一直醒著，不能永遠用第一天抓到的資料"""
    return int(time.time() // CACHE_SECONDS)


# 同一份資料同時只抓一次（預熱和第一個請求不會各抓一份，免費主機記憶體只有 512 MB）
_fetch_lock = threading.Lock()


# 訊號只需要約 100 天（90 天 z-score + 7 天變化），績效只需要最近的價格；抓 400 天就夠，
# 不必每小時把 2020 年至今全部重抓（備援來源 OKX 每頁 100 根，全抓要 20 多次請求，會被限流）
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
    """資料已經包含昨天（UTC）的收盤：今天之內不會有新的收盤，沿用也不會讓訊號過時"""
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
            # 每小時的更新失敗（來源暫時擋我們）：手上的資料如果已經含昨天收盤，就照用——內容完全一樣
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
        raise HTTPException(404, f"不支援的資產：{asset}，可用：{list(SYMBOLS)}")
    if not _from_gateway(x_veriflow_gateway):
        raise HTTPException(402, "Payment required：請透過 x402 付款關卡取得訊號")
    if SIGNAL_VERSION == "v2":
        return _v2_signal(asset)
    s = latest_signal(asset, build_factors(_supply(), _prices(asset)))
    # 每個資產每個收盤日只有一筆官方訊號：當天已經發過（每日排程或先前的買家），就賣同一筆，不產生新的承諾。
    # 否則每次購買都會多一個雜湊，紀錄上同一天會有好幾筆，也無法證明賣方沒有兩邊都押。
    rows = ledger.for_day(asset, s.as_of)
    anchored = [r for r in rows if r["anchor_tx"]]
    if anchored or rows:
        r = (anchored or rows)[0]
        out = {"signal": json.loads(r["canonical"]), "canonical": r["canonical"], "commitment": r["commitment"]}
        if r["anchor_tx"]:
            out["anchor_tx"] = r["anchor_tx"]  # 已上鏈：付款關卡不再重複上鏈
        return out
    commitment = ledger.record(s)
    return {"signal": s.__dict__, "canonical": s.canonical(), "commitment": commitment}


def _v2_signal(asset: str) -> dict:
    """v2：只賣 daily-v2（GitHub Actions）產生、已經在合約 v2 上鏈的昨日收盤訊號；這裡不產生新訊號"""
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
    每日公開訊號（只接受付款關卡呼叫）：每個資產每個收盤日至少一筆上鏈的訊號，
    讓績效紀錄每天累積，不依賴有沒有人付費購買。
      - 這一天已經有上鏈的訊號 → {"status": "exists"}，不重複發
      - 有訊號但上鏈失敗過 → 回傳那一筆，讓關卡重新上鏈
      - 都沒有 → 發一筆新的
    """
    _require_gateway(x_veriflow_gateway)
    if SIGNAL_VERSION == "v2":
        raise HTTPException(410, "v1 daily signals are retired; v2 signals come from the daily-v2 workflow")
    asset = asset.upper()
    if asset not in SYMBOLS:
        raise HTTPException(404, f"不支援的資產：{asset}")
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
    df = ledger.all()[["commitment", "asset", "as_of", "issued_at", "anchor_tx"]]
    # 還沒上鏈的訊號 anchor_tx 是空值；pandas 會變成 NaN，JSON 不接受，要轉成 None
    return df.astype(object).where(df.notna(), None).to_dict("records")


class Anchor(BaseModel):
    anchor_tx: str


def _require_gateway(secret: str | None):
    if not _from_gateway(secret):
        raise HTTPException(403, "只接受付款關卡的請求")


@app.post("/commitments/{commitment}/anchor")
def set_anchor(commitment: str, body: Anchor, x_veriflow_gateway: str | None = Header(default=None)):
    _require_gateway(x_veriflow_gateway)
    if not ledger.get(commitment):
        raise HTTPException(404, "找不到這個承諾")
    ledger.set_anchor(commitment, body.anchor_tx)
    return {"ok": True}


@app.get("/commitments/{commitment}")
def get_commitment(commitment: str):
    row = ledger.get(commitment)
    if not row:
        raise HTTPException(404, "找不到這個承諾")
    matured = datetime.now(timezone.utc).date() >= (
        datetime.fromisoformat(row["as_of"]).date() + timedelta(days=HORIZON_DAYS)
    )
    out = {k: row[k] for k in ("commitment", "asset", "as_of", "issued_at", "anchor_tx")}
    out["revealed"] = matured
    if matured:
        # 揭露完整內容：sha256(canonical) 必須等於 commitment，且等於鏈上 veriflow:v1:<commitment>
        out["canonical"] = row["canonical"]
    return out
