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

import os
import threading
import time
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
GATEWAY_SECRET = os.environ.get("GATEWAY_SECRET", "")  # 空字串 = 開發模式，不檢查


CACHE_SECONDS = int(os.environ.get("DATA_CACHE_SECONDS", "3600"))


def _hour_bucket() -> int:
    """快取每小時換一次：部署後服務一直醒著，不能永遠用第一天抓到的資料"""
    return int(time.time() // CACHE_SECONDS)


# 同一份資料同時只抓一次（預熱和第一個請求不會各抓一份，免費主機記憶體只有 512 MB）
_fetch_lock = threading.Lock()


@lru_cache(maxsize=4)
def _prices_cached(asset: str, bucket: int):
    return fetch_prices(asset)


@lru_cache(maxsize=1)
def _supply_cached(bucket: int):
    return fetch_supply()


def _prices_at(asset: str, bucket: int):
    with _fetch_lock:
        return _prices_cached(asset, bucket)


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
    if GATEWAY_SECRET and x_veriflow_gateway != GATEWAY_SECRET:
        raise HTTPException(402, "Payment required：請透過 x402 付款關卡取得訊號")
    s = latest_signal(asset, build_factors(_supply(), _prices(asset)))
    commitment = ledger.record(s)
    return {"signal": s.__dict__, "canonical": s.canonical(), "commitment": commitment}


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
    return ledger.track_record({a: _prices(a) for a in SYMBOLS})


@app.get("/commitments")
def commitments():
    df = ledger.all()[["commitment", "asset", "as_of", "issued_at", "anchor_tx"]]
    # 還沒上鏈的訊號 anchor_tx 是空值；pandas 會變成 NaN，JSON 不接受，要轉成 None
    return df.astype(object).where(df.notna(), None).to_dict("records")


class Anchor(BaseModel):
    anchor_tx: str


def _require_gateway(secret: str | None):
    if GATEWAY_SECRET and secret != GATEWAY_SECRET:
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
