"""
驗證邏輯：任何人都能檢查「這個訊號在結果出來前就上鏈、而且沒被改過」
------------------------------------------------------------------
三個檢查：
  1. 鏈上交易已確認
  2. 鏈上資料 == "veriflow:v1:" + 承諾雜湊
  3. 重算 sha256(訊號完整內容) == 承諾雜湊（需要訊號內容：買方手上有，或滿 7 天後公開）
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

ANCHOR_PREFIX = "veriflow:v1:"


@dataclass
class Check:
    name: str
    ok: bool
    detail: str


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def verify(commitment: str, onchain: dict | None, canonical: str | None = None) -> list[Check]:
    checks: list[Check] = []

    status = (onchain or {}).get("status")
    checks.append(Check(
        "鏈上交易已確認",
        status in ("finalized", "committed"),
        f"狀態：{status or '查不到'}" + (f"，發送者 {onchain.get('sender')}" if onchain and onchain.get("sender") else ""),
    ))

    expected = ANCHOR_PREFIX + commitment
    got = (onchain or {}).get("data_text")
    checks.append(Check(
        "鏈上資料與承諾一致",
        got == expected,
        f"鏈上：{got or '無資料'}",
    ))

    if canonical is not None:
        h = sha256_hex(canonical)
        checks.append(Check(
            "訊號內容的雜湊與承諾一致",
            h == commitment,
            f"重算 SHA-256：{h}",
        ))
    return checks


def all_ok(checks: list[Check]) -> bool:
    return bool(checks) and all(c.ok for c in checks)
