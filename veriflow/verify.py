"""
Verification: anyone can check that a signal was on-chain before its outcome and has not been changed
------------------------------------------------------------------
Checks:
  1. the on-chain transaction is confirmed
  2. on-chain data == "veriflow:v1:" + commitment hash
  3. recomputed sha256(full signal content) == commitment hash (needs the content: the buyer has it, or it is public after 7 days)
  4. anchored within a day of the data's close (when content and block time are available): long before the 7-day outcome, so it cannot be backfilled
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
    """The data date in the signal content (YYYY-MM-DD)"""
    try:
        v = json.loads(canonical).get("as_of")
        datetime.strptime(v, "%Y-%m-%d")
        return v
    except (ValueError, TypeError, AttributeError):
        return None


def anchored_in_time(as_of: str, block_time: str) -> Check:
    """The as_of daily candle closes at 00:00 UTC the next day; the signal must be anchored within a day of that close"""
    day = datetime.strptime(as_of, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    closed, deadline = day + timedelta(days=1), day + timedelta(days=2)
    try:
        t = datetime.fromisoformat(block_time.replace("Z", "+00:00"))
        ok = closed <= t < deadline
    except ValueError:
        ok = False
    return Check("anchored after the data close and within a day of it (long before the 7-day outcome)", ok,
                 f"anchored {block_time}; data {as_of} closed {closed.isoformat()}")


def verify(commitment: str, onchain: dict | None, canonical: str | None = None) -> list[Check]:
    checks: list[Check] = []

    status = (onchain or {}).get("status")
    checks.append(Check(
        "on-chain transaction confirmed",
        status in ("finalized", "committed"),
        f"status: {status or 'not found'}" + (f", sender {onchain.get('sender')}" if onchain and onchain.get("sender") else ""),
    ))

    expected = ANCHOR_PREFIX + commitment
    got = (onchain or {}).get("data_text")
    checks.append(Check(
        "on-chain data equals the commitment",
        got == expected,
        f"on-chain: {got or 'no data'}",
    ))

    if canonical is not None:
        h = sha256_hex(canonical)
        checks.append(Check(
            "content hashes to the commitment",
            h == commitment,
            f"recomputed SHA-256: {h}",
        ))
        as_of, block_time = as_of_of(canonical), (onchain or {}).get("block_time")
        if as_of:
            checks.append(anchored_in_time(as_of, block_time or "(unknown)"))
    return checks


def all_ok(checks: list[Check]) -> bool:
    return bool(checks) and all(c.ok for c in checks)
