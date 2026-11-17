"""不需要網路的測試：用假資料檢查因子、訊號、承諾雜湊與帳本評分"""

import numpy as np
import pandas as pd

from veriflow.ledger import Ledger
from veriflow.signal import RISK_OFF, RISK_ON, build_factors, latest_signal, verify_commitment


def fake_data(days=200, trend=0.002, seed=0):
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2025-01-01", periods=days, freq="D")
    close = 100 * np.exp(np.cumsum(trend + rng.normal(0, 0.02, days)))
    flows = pd.DataFrame({"inflow_usd": rng.uniform(90, 110, days),
                          "outflow_usd": rng.uniform(90, 110, days)}, index=idx)
    return flows, pd.DataFrame({"close": close}, index=idx)


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


def test_track_record_scores_only_matured(tmp_path):
    flows, prices = fake_data()
    f = build_factors(flows, prices)
    led = Ledger(tmp_path / "t.db")
    s = latest_signal("BTC", f.iloc[:-10])             # 10 天前的訊號 → 已到期
    led.record(s)
    led.record(latest_signal("BTC", f))                # 今天的訊號 → 未到期
    tr = led.track_record({"BTC": prices})
    assert tr["issued"] == 2 and tr["scored"] == 1
    assert tr["hit_rate"] in (0.0, 1.0)
