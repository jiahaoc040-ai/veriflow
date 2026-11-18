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
