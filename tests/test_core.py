"""不需要網路的測試：用假資料檢查因子、訊號、承諾雜湊、帳本評分與 DefiLlama 解析"""

import numpy as np
import pandas as pd

from veriflow.ledger import Ledger
from veriflow.signal import RISK_OFF, RISK_ON, build_factors, latest_signal, verify_commitment


def fake_data(days=200, trend=0.002, seed=0):
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2025-01-01", periods=days, freq="D")
    close = 100 * np.exp(np.cumsum(trend + rng.normal(0, 0.02, days)))
    supply = pd.DataFrame({"supply_usd": 1e11 * np.exp(np.cumsum(rng.normal(0.0005, 0.002, days)))}, index=idx)
    return supply, pd.DataFrame({"close": close}, index=idx)


def test_factors_have_signals_after_warmup():
    flows, prices = fake_data()
    d = build_factors(flows, prices)
    assert d["signal"].iloc[:90].isna().all()          # 暖機期不給訊號
    assert set(d["signal"].dropna()) <= {RISK_ON, RISK_OFF}


def test_strong_uptrend_is_mostly_risk_on():
    flows, prices = fake_data(trend=0.01)
    d = build_factors(flows, prices).dropna(subset=["signal"])
    assert (d["signal"] == RISK_ON).mean() > 0.7


def test_commitment_roundtrip_and_tamper():
    flows, prices = fake_data()
    s = latest_signal("BTC", build_factors(flows, prices))
    c = s.commitment()
    assert verify_commitment(s.canonical(), c)
    tampered = s.canonical().replace(s.signal, RISK_OFF if s.signal == RISK_ON else RISK_ON)
    assert not verify_commitment(tampered, c)          # 改內容就對不上


def test_nonce_hides_signal():
    flows, prices = fake_data()
    f = build_factors(flows, prices)
    a, b = latest_signal("BTC", f), latest_signal("BTC", f)
    assert a.signal == b.signal and a.commitment() != b.commitment()


def test_track_record_counts_matured_and_publishes_no_hit_rate(tmp_path):
    flows, prices = fake_data()
    f = build_factors(flows, prices)
    led = Ledger(tmp_path / "t.db")
    s = latest_signal("BTC", f.iloc[:-10])             # 10 天前的訊號 → 已到期
    led.set_anchor(led.record(s), "aa" * 32)
    led.set_anchor(led.record(latest_signal("BTC", f)), "bb" * 32)   # 今天的訊號 → 未到期
    tr = led.track_record({"BTC": prices}, now=prices.index[-1])
    assert tr["issued"] == 2 and tr["matured"] == 1
    assert "hit_rate" not in tr and "hit" not in tr["signals"][0]
    assert tr["scoring_rule"].endswith("docs/SCORING-v2.md") and tr["scoring_rule_v1"].endswith("docs/SCORING.md")


def test_track_record_counts_each_day_once_and_only_anchored(tmp_path):
    """同一天有好幾筆上鏈承諾：不隱藏，照實回報為重複；沒上鏈的不列"""
    flows, prices = fake_data()
    f = build_factors(flows, prices)
    led = Ledger(tmp_path / "t.db")
    old = f.iloc[:-10]
    first = led.record(latest_signal("BTC", old))
    led.set_anchor(first, "aa" * 32)
    for _ in range(3):                                  # 同一天又賣了 3 次
        led.set_anchor(led.record(latest_signal("BTC", old)), "cc" * 32)
    led.record(latest_signal("BTC", f.iloc[:-12]))      # 另一天，但從沒上鏈
    tr = led.track_record({"BTC": prices})
    assert tr["issued"] == 5 and tr["signal_days"] == 1 and tr["duplicate_asset_days"] == 1
    assert tr["signals"][0]["commitment"] == first and len(tr["signals"]) == 4   # 四筆上鏈都列出


def test_parse_llama():
    from veriflow.data import parse_llama
    rows = [{"date": "1704067200", "totalCirculatingUSD": {"peggedUSD": 1.3e11, "peggedEUR": 1e8}},
            {"date": "1704153600", "totalCirculatingUSD": {"peggedUSD": 1.31e11}},
            {"date": "1704240000", "totalCirculatingUSD": {}}]
    df = parse_llama(rows)
    assert list(df.index.strftime("%Y-%m-%d")) == ["2024-01-01", "2024-01-02"]
    assert df["supply_usd"].iloc[0] == 1.3e11 + 1e8
