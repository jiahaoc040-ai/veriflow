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
