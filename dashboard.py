"""
VeriFlow local dashboard (legacy Streamlit version; the live dashboard is gateway/public/index.html): record + one-click on-chain verification
---------------------------------------
Run: streamlit run dashboard.py
(needs the payment gateway running: default http://localhost:4020)
"""

from __future__ import annotations

import os

import httpx
import pandas as pd
import streamlit as st

from veriflow.verify import all_ok, sha256_hex, verify

EXPLORER = "https://ccdexplorer.io/testnet/transaction/"

st.set_page_config(page_title="VeriFlow", page_icon="🔗", layout="wide")
gateway = st.sidebar.text_input("Gateway URL", os.environ.get("GATEWAY_URL", "http://localhost:4020"))


def get(path: str):
    r = httpx.get(f"{gateway}{path}", timeout=30)
    r.raise_for_status()
    return r.json()


def show_checks(checks):
    for c in checks:
        st.markdown(f"{'✅' if c.ok else '❌'} **{c.name}**  \n<small>{c.detail}</small>", unsafe_allow_html=True)
    if all_ok(checks):
        st.success("Verified: this signal was written on-chain before the outcome, and the content is unchanged.")
    else:
        st.error("Verification failed: the on-chain record does not match this content.")


st.title("VeriFlow")
st.caption("On-chain stablecoin-liquidity signals for AI agents — sold only to verified buyers, "
           "with a track record anyone can verify on Concordium.")

try:
    tr = get("/track-record")
    commitments = get("/commitments")
except Exception as e:  # noqa: BLE001
    st.error(f"cannot reach the payment gateway {gateway}: {e}")
    st.stop()

# ── Record ─────────────────────────────────────────────
c1, c2, c3 = st.columns(3)
c1.metric("Signals issued", tr["issued"])
c2.metric(f"Past the horizon ({tr['horizon_days']} days)", tr.get("matured", tr.get("scored")))
c3.metric("Asset-days with more than one commit", tr.get("duplicate_asset_days", "—"))
st.caption("Only the hash is public when a signal is issued; the full content is revealed after 7 days. No hit rate is shown: the score comes from the on-chain scoring rule.")

# ── Signals + one-click verification ─────────────────────────────
st.subheader("On-chain commitments")
if not commitments:
    st.info("No signals yet. Buy one with `npm run buyer -- BTC`.")
else:
    df = pd.DataFrame(commitments).sort_values("issued_at", ascending=False)
    for _, row in df.iterrows():
        cm, tx = row["commitment"], row["anchor_tx"]
        cols = st.columns([1.2, 0.8, 3, 2, 1.2])
        cols[0].write(row["as_of"])
        cols[1].write(row["asset"])
        cols[2].code(cm[:16] + "…", language=None)
        cols[3].markdown(f"[{tx[:12]}…]({EXPLORER}{tx})" if tx else "⏳ not anchored yet")
        if tx and cols[4].button("Verify", key=cm):
            with st.container(border=True):
                detail = get(f"/commitments/{cm}")
                onchain = get(f"/onchain/{tx}")
                st.markdown(f"**Decoded on-chain:** `{onchain.get('data_text')}`")
                canonical = detail.get("canonical")
                if canonical is None:
                    st.caption("🔒 The signal content is public after 7 days; for now only the on-chain commitment is checked. Buyers can verify the content with the tool below.")
                show_checks(verify(cm, onchain, canonical))

# ── Verify what you bought ────────────────────────────────────
st.subheader("Verify a signal you bought")
st.caption("Paste the `canonical` content from your purchase. Change any character and verification fails.")
pasted = st.text_area("canonical", height=110, placeholder='{"as_of":"2026-11-17","asset":"BTC",...}')
if st.button("Verify this signal") and pasted.strip():
    h = sha256_hex(pasted.strip())
    match = next((c for c in commitments if c["commitment"] == h), None)
    if match is None:
        st.error(f"❌ The hash of this content `{h[:16]}…` is in no on-chain commitment: it was changed, or it is not a VeriFlow signal.")
    elif not match["anchor_tx"]:
        st.warning("Commitment found, but not anchored yet.")
    else:
        st.markdown(f"**On-chain transaction:** [{match['anchor_tx']}]({EXPLORER}{match['anchor_tx']})")
        show_checks(verify(h, get(f"/onchain/{match['anchor_tx']}"), pasted.strip()))
