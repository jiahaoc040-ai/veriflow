"""
VeriFlow 儀表板：訊號績效 + 鏈上一鍵驗證
---------------------------------------
執行：streamlit run dashboard.py
（需要付款關卡在跑：預設 http://localhost:4020）
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
        st.success("驗證通過：這個訊號在結果出來之前就寫上鏈，內容沒有被改過。")
    else:
        st.error("驗證失敗：鏈上紀錄與這份內容對不上。")


st.title("VeriFlow")
st.caption("On-chain stablecoin-liquidity signals for AI agents — sold only to verified buyers, "
           "with a track record anyone can verify on Concordium.")

try:
    tr = get("/track-record")
    commitments = get("/commitments")
except Exception as e:  # noqa: BLE001
    st.error(f"連不到付款關卡 {gateway}：{e}")
    st.stop()

# ── 績效 ─────────────────────────────────────────────
c1, c2, c3 = st.columns(3)
c1.metric("已發出訊號", tr["issued"])
c2.metric(f"已到期（{tr['horizon_days']} 天）", tr["scored"])
c3.metric("命中率", "—" if tr["hit_rate"] is None else f"{tr['hit_rate']:.0%}")
st.caption("訊號發出時只公開雜湊；滿 7 天後揭露完整內容並計分。命中 = RISK_ON 後上漲、RISK_OFF 後下跌。")

# ── 訊號列表 + 一鍵驗證 ─────────────────────────────
st.subheader("鏈上承諾")
if not commitments:
    st.info("還沒有訊號。用 `npm run buyer -- BTC` 買一個。")
else:
    df = pd.DataFrame(commitments).sort_values("issued_at", ascending=False)
    for _, row in df.iterrows():
        cm, tx = row["commitment"], row["anchor_tx"]
        cols = st.columns([1.2, 0.8, 3, 2, 1.2])
        cols[0].write(row["as_of"])
        cols[1].write(row["asset"])
        cols[2].code(cm[:16] + "…", language=None)
        cols[3].markdown(f"[{tx[:12]}…]({EXPLORER}{tx})" if tx else "⏳ 尚未上鏈")
        if tx and cols[4].button("一鍵驗證", key=cm):
            with st.container(border=True):
                detail = get(f"/commitments/{cm}")
                onchain = get(f"/onchain/{tx}")
                st.markdown(f"**鏈上解碼：** `{onchain.get('data_text')}`")
                canonical = detail.get("canonical")
                if canonical is None:
                    st.caption("🔒 訊號內容在 7 天後公開；現在先驗證鏈上承諾。買到訊號的人可以用下方的工具驗證內容。")
                show_checks(verify(cm, onchain, canonical))

# ── 買方自己驗證 ────────────────────────────────────
st.subheader("驗證你買到的訊號")
st.caption("貼上購買時拿到的 `canonical` 內容。改任何一個字，驗證就會失敗。")
pasted = st.text_area("canonical", height=110, placeholder='{"as_of":"2026-11-17","asset":"BTC",...}')
if st.button("驗證這份訊號") and pasted.strip():
    h = sha256_hex(pasted.strip())
    match = next((c for c in commitments if c["commitment"] == h), None)
    if match is None:
        st.error(f"❌ 這份內容的雜湊 `{h[:16]}…` 不在任何鏈上承諾裡：內容被改過，或不是 VeriFlow 發出的訊號。")
    elif not match["anchor_tx"]:
        st.warning("找到承諾，但還沒上鏈。")
    else:
        st.markdown(f"**鏈上交易：** [{match['anchor_tx']}]({EXPLORER}{match['anchor_tx']})")
        show_checks(verify(h, get(f"/onchain/{match['anchor_tx']}"), pasted.strip()))
