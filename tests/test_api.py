"""API 測試：付款保護、上鏈回報、到期才揭露（用假資料，不需要網路）"""

import importlib

from fastapi.testclient import TestClient

from tests.test_core import fake_data
from veriflow.signal import verify_commitment


def make_client(tmp_path, monkeypatch, secret="s"):
    monkeypatch.setenv("VERIFLOW_DB", str(tmp_path / "api.db"))
    monkeypatch.setenv("GATEWAY_SECRET", secret)
    import veriflow.api as api
    api = importlib.reload(api)
    supply, prices = fake_data()
    api._supply = lambda: supply
    api._prices = lambda a: prices
    return api, TestClient(api.app)


def test_signal_requires_gateway(tmp_path, monkeypatch):
    _, c = make_client(tmp_path, monkeypatch)
    assert c.get("/signal/BTC").status_code == 402
    assert c.get("/signal/BTC", headers={"X-VeriFlow-Gateway": "s"}).status_code == 200


def test_anchor_and_reveal(tmp_path, monkeypatch):
    api, c = make_client(tmp_path, monkeypatch)
    body = c.get("/signal/BTC", headers={"X-VeriFlow-Gateway": "s"}).json()
    cm = body["commitment"]

    # 只有付款關卡能回報上鏈交易
    assert c.post(f"/commitments/{cm}/anchor", json={"anchor_tx": "ab" * 32}).status_code == 403
    r = c.post(f"/commitments/{cm}/anchor", json={"anchor_tx": "ab" * 32}, headers={"X-VeriFlow-Gateway": "s"})
    assert r.status_code == 200
    assert c.post("/commitments/nope/anchor", json={"anchor_tx": "x"}, headers={"X-VeriFlow-Gateway": "s"}).status_code == 404

    # fake_data 的資料日期在過去，已過 7 天 → 揭露完整內容，雜湊可重算
    got = c.get(f"/commitments/{cm}").json()
    assert got["anchor_tx"] == "ab" * 32 and got["revealed"] is True
    assert verify_commitment(got["canonical"], cm)


def test_commitments_with_unanchored_signal(tmp_path, monkeypatch):
    _, c = make_client(tmp_path, monkeypatch)
    c.get("/signal/BTC", headers={"X-VeriFlow-Gateway": "s"})   # 沒有上鏈紀錄
    r = c.get("/commitments")
    assert r.status_code == 200 and r.json()[0]["anchor_tx"] is None


def test_price_cache_refreshes_each_hour(monkeypatch):
    """服務一直醒著時，價格每小時要重新抓，不能永遠用第一次的資料"""
    import veriflow.api as api_mod

    calls = []
    monkeypatch.setattr(api_mod, "fetch_prices", lambda a: calls.append(a) or a)
    api_mod._prices_at.cache_clear()
    now = [1_000_000.0]
    monkeypatch.setattr(api_mod.time, "time", lambda: now[0])
    api_mod._prices_at("BTC", api_mod._hour_bucket())
    api_mod._prices_at("BTC", api_mod._hour_bucket())
    assert calls == ["BTC"]                     # 同一小時：用快取
    now[0] += api_mod.CACHE_SECONDS
    api_mod._prices_at("BTC", api_mod._hour_bucket())
    assert calls == ["BTC", "BTC"]              # 下一小時：重新抓


def test_daily_signal_once_per_day_and_retries_unanchored(tmp_path, monkeypatch):
    """每日訊號：同一收盤日只上鏈一筆；上鏈失敗的那筆會被重送，不會另發新的"""
    api, c = make_client(tmp_path, monkeypatch)
    gw = {"X-VeriFlow-Gateway": "s"}
    assert c.post("/daily/BTC").status_code == 403            # 只有付款關卡能呼叫
    first = c.post("/daily/BTC", headers=gw).json()
    assert first["status"] == "new"
    again = c.post("/daily/BTC", headers=gw).json()           # 還沒上鏈 → 重送同一筆
    assert again == {**first, "status": "retry"}
    c.post(f"/commitments/{first['commitment']}/anchor", json={"anchor_tx": "cd" * 32}, headers=gw)
    assert c.post("/daily/BTC", headers=gw).json()["status"] == "exists"
    assert c.post("/daily/ETH", headers=gw).json()["status"] == "new"   # 各資產分開
    assert c.post("/daily/DOGE", headers=gw).status_code == 404
