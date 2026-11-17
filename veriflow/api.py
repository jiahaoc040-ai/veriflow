"""
VeriFlow 訊號 API（FastAPI）
---------------------------
執行：uvicorn veriflow.api:app --reload

端點：
  GET /health            健康檢查
  GET /signal/{asset}    取得最新訊號（之後由 x402 付款關卡保護）
  GET /track-record      命中率與所有已評分訊號（公開）
  GET /commitments       所有承諾雜湊與上鏈交易（公開）

付款保護：x402 關卡（TypeScript）驗證付款後，帶著 X-VeriFlow-Gateway 標頭轉發過來。
API 只接受帶正確密鑰的請求，所以沒付款的人無法繞過關卡直接拿訊號。
"""

from __future__ import annotations

import os
from functools import lru_cache

from fastapi import FastAPI, Header, HTTPException

from .data import SYMBOLS, fetch_supply, fetch_prices
from .ledger import Ledger
from .signal import build_factors, latest_signal

app = FastAPI(title="VeriFlow", version="0.1.0")
ledger = Ledger(os.environ.get("VERIFLOW_DB", "veriflow.db"))
GATEWAY_SECRET = os.environ.get("GATEWAY_SECRET", "")  # 空字串 = 開發模式，不檢查


@lru_cache(maxsize=8)
def _prices(asset: str):
    return fetch_prices(asset)


@lru_cache(maxsize=1)
def _supply():
    return fetch_supply()


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


@app.get("/track-record")
def track_record():
    return ledger.track_record({a: _prices(a) for a in SYMBOLS})


@app.get("/commitments")
def commitments():
    return ledger.all()[["commitment", "asset", "as_of", "issued_at", "anchor_tx"]].to_dict("records")
