"""
命令列：算出最新訊號並記到帳本
執行：python scripts/run_signal.py BTC
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from veriflow.data import fetch_supply, fetch_prices  # noqa: E402
from veriflow.ledger import Ledger  # noqa: E402
from veriflow.signal import build_factors, latest_signal  # noqa: E402

if __name__ == "__main__":
    asset = (sys.argv[1] if len(sys.argv) > 1 else "BTC").upper()
    s = latest_signal(asset, build_factors(fetch_supply(), fetch_prices(asset)))
    commitment = Ledger().record(s)
    print(json.dumps({"signal": s.__dict__, "commitment": commitment}, indent=2, ensure_ascii=False))
