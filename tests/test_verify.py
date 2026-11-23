from veriflow.verify import all_ok, sha256_hex, verify

CANON = '{"asset":"BTC","signal":"RISK_OFF"}'
C = sha256_hex(CANON)
CHAIN = {"status": "finalized", "sender": "4dNM", "data_text": f"veriflow:v1:{C}"}


def test_all_pass():
    assert all_ok(verify(C, CHAIN, CANON))


def test_tampered_content_fails():
    checks = verify(C, CHAIN, CANON.replace("RISK_OFF", "RISK_ON"))
    assert not all_ok(checks) and checks[2].ok is False


def test_wrong_chain_data_fails():
    assert not all_ok(verify(C, {**CHAIN, "data_text": "veriflow:v1:" + "0" * 64}, CANON))


def test_pending_or_missing_fails():
    assert not all_ok(verify(C, {"status": "pending"}))
    assert not all_ok(verify(C, None))


def test_without_content_checks_chain_only():
    checks = verify(C, CHAIN)
    assert len(checks) == 2 and all_ok(checks)


def test_anchoring_time_must_be_within_a_day_of_the_close():
    """11-19 的日 K 在 11-20 00:00 UTC 收盤；期限 11-21 00:00 UTC。等結果出來才補寫的不算數"""
    from veriflow.verify import all_ok, sha256_hex, verify

    canon = '{"as_of":"2026-11-19","asset":"BTC","nonce":"ab","signal":"RISK_ON"}'
    c = sha256_hex(canon)
    chain = lambda t: {"status": "finalized", "data_text": f"veriflow:v1:{c}", "block_time": t}  # noqa: E731
    on_time = verify(c, chain("2026-11-20T05:00:42.000Z"), canon)
    assert len(on_time) == 4 and all_ok(on_time)
    assert not all_ok(verify(c, chain("2026-11-27T01:00:00.000Z"), canon))
    assert not all_ok(verify(c, chain("2026-11-19T23:59:59.000Z"), canon))  # 收盤前上鏈
    assert not all_ok(verify(c, {"status": "finalized", "data_text": f"veriflow:v1:{c}"}, canon))  # 時間不明
