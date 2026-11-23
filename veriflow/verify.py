"""
驗證邏輯：任何人都能檢查「這個訊號在結果出來前就上鏈、而且沒被改過」
------------------------------------------------------------------
三個檢查：
  1. 鏈上交易已確認
  2. 鏈上資料 == "veriflow:v1:" + 承諾雜湊
  3. 重算 sha256(訊號完整內容) == 承諾雜湊（需要訊號內容：買方手上有，或滿 7 天後公開）
  4. 上鏈時間在資料收盤後一天內（有內容與區塊時間時）：遠早於 7 天後的結果，不能等結果出來才補寫
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

ANCHOR_PREFIX = "veriflow:v1:"


@dataclass
class Check:
    name: str
    ok: bool
    detail: str


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def as_of_of(canonical: str) -> str | None:
    """訊號內容裡的資料日期（YYYY-MM-DD）"""
    try:
        v = json.loads(canonical).get("as_of")
        datetime.strptime(v, "%Y-%m-%d")
        return v
    except (ValueError, TypeError, AttributeError):
        return None


def anchored_in_time(as_of: str, block_time: str) -> Check:
    """as_of 那根日 K 在隔天 00:00 UTC 收盤；訊號必須在收盤後一天內上鏈"""
    day = datetime.strptime(as_of, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    closed, deadline = day + timedelta(days=1), day + timedelta(days=2)
    try:
        t = datetime.fromisoformat(block_time.replace("Z", "+00:00"))
        ok = closed <= t < deadline
    except ValueError:
        ok = False
    return Check("上鏈時間在資料收盤之後、一天之內（遠早於 7 天後的結果）", ok,
                 f"上鏈 {block_time}；資料 {as_of} 於 {closed.isoformat()} 收盤")


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
        as_of, block_time = as_of_of(canonical), (onchain or {}).get("block_time")
        if as_of:
            checks.append(anchored_in_time(as_of, block_time or "(unknown)"))
    return checks


def all_ok(checks: list[Check]) -> bool:
    return bool(checks) and all(c.ok for c in checks)
