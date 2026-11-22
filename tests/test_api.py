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


def test_no_secret_fails_closed_unless_dev_flag(tmp_path, monkeypatch):
    """沒設 GATEWAY_SECRET 不再等於全開：預設拒絕，只有 VERIFLOW_INSECURE_DEV=1 才放行"""
    monkeypatch.delenv("VERIFLOW_INSECURE_DEV", raising=False)
    _, c = make_client(tmp_path, monkeypatch, secret="")
    assert c.get("/signal/BTC").status_code == 402
    assert c.post("/daily/BTC").status_code == 403
    monkeypatch.setenv("VERIFLOW_INSECURE_DEV", "1")
    _, c = make_client(tmp_path, monkeypatch, secret="")
    assert c.get("/signal/BTC").status_code == 200


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
    monkeypatch.setattr(api_mod, "fetch_prices", lambda a, since=None: calls.append(a) or a)
    api_mod._prices_cached.cache_clear()
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


def test_parse_klines_drops_unclosed_today():
    """Binance /klines 的格式；今天（UTC）還沒收盤的那根不能用"""
    import pandas as pd

    from veriflow.data import parse_klines

    today = pd.Timestamp.now(tz="UTC").normalize()
    ms = lambda t: int(t.timestamp() * 1000)
    rows = [[ms(today - pd.Timedelta(days=d)), "1", "2", "0.5", str(100 + d), "9"] for d in (2, 1, 0)]
    df = parse_klines(rows)
    assert list(df["close"]) == [102.0, 101.0]
    assert df.index[-1] == (today - pd.Timedelta(days=1)).tz_localize(None)


def test_fetch_prices_falls_back_when_an_endpoint_blocks(monkeypatch):
    """Binance 某個網域擋了主機 IP（418/451）時，改用下一個公開網域"""
    import httpx

    from veriflow import data

    tried = []

    def fake(base, symbol, start):
        tried.append(base)
        if len(tried) == 1:
            raise httpx.HTTPStatusError("418", request=httpx.Request("GET", base), response=httpx.Response(418))
        return [[1_600_000_000_000, "1", "1", "1", "42", "1"]]

    monkeypatch.setattr(data, "_fetch_klines", fake)
    df = data.fetch_prices("BTC")
    assert len(tried) == 2 and list(df["close"]) == [42.0]


def test_okx_fallback_when_binance_bans_the_host(monkeypatch):
    """Binance 所有網域都回 418（整個 IP 被封）→ 用 OKX 日 K，只留已收盤、轉成同樣格式"""
    import httpx
    import pandas as pd

    from veriflow import data

    def banned(base, symbol, start):
        raise httpx.HTTPStatusError("418 I'm a teapot\nmore", request=httpx.Request("GET", base), response=httpx.Response(418))

    day = 86_400_000
    t0 = int(pd.Timestamp("2026-01-10", tz="UTC").timestamp() * 1000)
    pages = [
        [[str(t0 + 2 * day), "1", "1", "1", "103", "1", "1", "1", "0"],      # 今天：未收盤
         [str(t0 + day), "1", "1", "1", "102", "1", "1", "1", "1"],
         [str(t0), "1", "1", "1", "101", "1", "1", "1", "1"]],
    ]

    class FakeClient:
        def __init__(self, **kw): self.calls = 0
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def get(self, url, params):
            assert params["bar"] == "1Dutc" and params["instId"] == "BTC-USDT"
            page = pages[self.calls] if self.calls < len(pages) else []
            self.calls += 1
            return httpx.Response(200, json={"code": "0", "msg": "", "data": page}, request=httpx.Request("GET", url))

    monkeypatch.setattr(data, "_fetch_klines", banned)
    monkeypatch.setattr(data.httpx, "Client", FakeClient)
    df = data.fetch_prices("BTC", since="2026-01-01")
    assert list(df["close"]) == [101.0, 102.0]


def test_price_refresh_failure_reuses_data_that_is_still_current(monkeypatch):
    """每小時更新失敗（來源限流）：手上的資料已含昨天收盤就照用；已經過時就報錯，不發舊訊號"""
    import pandas as pd
    import pytest
    import veriflow.api as api_mod

    today = pd.Timestamp.now(tz="UTC").tz_localize(None).normalize()
    current = pd.DataFrame({"close": [1.0, 2.0]}, index=[today - pd.Timedelta(days=2), today - pd.Timedelta(days=1)])
    seen = {}
    monkeypatch.setattr(api_mod, "fetch_prices", lambda a, since=None: seen.setdefault("since", since) and current)
    api_mod._prices_cached.cache_clear()
    api_mod._last_good.clear()
    assert api_mod._prices_at("BTC", 1) is current
    # 只抓最近一段，不是 2020 年至今
    assert pd.Timestamp(seen["since"]) > today - pd.Timedelta(days=api_mod.PRICE_HISTORY_DAYS + 2)

    def down(a, since=None):
        raise RuntimeError("429 Too Many Requests")

    monkeypatch.setattr(api_mod, "fetch_prices", down)
    assert api_mod._prices_at("BTC", 2) is current          # 照用，內容一樣
    api_mod._last_good["BTC"] = current.iloc[:1]              # 只到前天：已過時
    with pytest.raises(RuntimeError):
        api_mod._prices_at("BTC", 3)


def test_paid_signal_is_the_one_official_signal_of_the_day(tmp_path, monkeypatch):
    """同一資產同一收盤日：每日排程發的、先前買家買的、現在買的，都是同一筆承諾"""
    api, c = make_client(tmp_path, monkeypatch)
    gw = {"X-VeriFlow-Gateway": "s"}
    daily = c.post("/daily/BTC", headers=gw).json()
    first = c.get("/signal/BTC", headers=gw).json()
    assert first["commitment"] == daily["commitment"] and "anchor_tx" not in first   # 還沒上鏈：交給付款關卡上鏈
    c.post(f"/commitments/{daily['commitment']}/anchor", json={"anchor_tx": "ef" * 32}, headers=gw)
    again = c.get("/signal/BTC", headers=gw).json()
    assert again["commitment"] == daily["commitment"] and again["anchor_tx"] == "ef" * 32
    assert again["canonical"] == first["canonical"]
    assert len(api.ledger.for_day("BTC", again["signal"]["as_of"])) == 1
