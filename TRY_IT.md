# Try VeriFlow yourself

There are two paths.

- **Path A** takes about 2 minutes and needs no wallet, no key and no trust in VeriFlow's server. You need a terminal with `sha256sum` (macOS: `shasum -a 256`), `curl` and `python3`, plus a browser.
- **Path B** takes about 30 minutes and pays for a call yourself on Concordium testnet.

## Path A: check a call that was already bought (2 minutes)

On 2026-11-22 a buyer agent paid 1 testnet CCD for the BTC call for the 2026-11-21 close. It received this exact string:

```
{"as_of":"2026-11-21","asset":"BTC","momentum_e6":-260395,"nonce":"7294f91f41330af85ea8f6af86dc2f9c","signal":"RISK_OFF"}
```

**1. Hash it.** The result is the commitment.

```bash
printf '%s' '{"as_of":"2026-11-21","asset":"BTC","momentum_e6":-260395,"nonce":"7294f91f41330af85ea8f6af86dc2f9c","signal":"RISK_OFF"}' | shasum -a 256
# 10cb3dc27d440d2e08278e7e454bd11abbb61ceffb91b34279ab28fd7d7a8eda
```

Change one character and the hash changes.

**2. Find that hash on-chain.** Open the commit transaction on CCDExplorer:
<https://ccdexplorer.io/testnet/transaction/fe340eeaa2623405880a57208c88004fb4f12b7b56479876e8be6f24a4ada718>

Check four things:
- It is the function `commit` on contract `<13115,0>` (`veriflow_registry_v2`), of type "contract updated".
- Under **Parameter** it shows asset `BTC`, `as_of` `2026-11-21` and the commitment `10cb3dc2…8eda`. The Event line below shows the same data as hex.
- Its timestamp is `2026-11-22 08:03:30`. The explorer shows times in UTC without saying so. That is within a day of the 2026-11-21 close. The call's outcome is known only when its exit candle closes, on 2026-11-30 00:00 UTC, about eight days later.
- The sender is shown as account index `19719`. Click it to see the address `4HgaCRwX…VwT3nmCj`. That is the committer the contract owner appointed, which you can confirm on the owner's [`set_committer` transaction `6e3eb548…`](https://ccdexplorer.io/testnet/transaction/6e3eb5483acbcdbf87717649b0941812513220c52b0623cc652c80678dc7668f) (sender `4dNMXmNK…`, parameter `4HgaCRwX…`).

The contract accepts one commit per asset and day, and only in the day after that close. A second hash for BTC on 2026-11-21 would have been rejected by the chain.

**3. Recompute the call from Binance.** The rule is public: `momentum_e6` is the 30-day change in the Binance BTCUSDT daily close, in millionths. The call is `RISK_ON` only if `momentum_e6` is above 0.

```bash
python3 - <<'EOF'
import json, urllib.request
def close(ms):
    url = f"https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime={ms}&limit=1"
    return json.load(urllib.request.urlopen(url))[0][4]          # decimal string
def units(s):                                                     # exact, in 1e-8
    i, _, f = s.partition("."); return int(i) * 10**8 + int((f + "0" * 8)[:8])
now, then = units(close(1795219200000)), units(close(1792627200000))  # 2026-11-21, 2026-10-22
n, d = (now - then) * 10**6, then
m = (2 * abs(n) + d) // (2 * d) * (1 if n >= 0 else -1)          # round half away from zero
print(m, "RISK_ON" if m > 0 else "RISK_OFF")                      # -260395 RISK_OFF
EOF
```

Binance's API refuses some locations (HTTP 451). If you get that, read the two closes on any BTCUSDT daily chart and compute `60215.77 / 81416.09 − 1`.

**4. Check that the scoring rule was fixed before the first call.** The owner registered the hashes of the rule files before the committer was appointed and before any commit:
<https://ccdexplorer.io/testnet/transaction/ecadec1b75cd764a2f87c512787cb3e5422148852760046978e2e4324d8b3271>

```bash
git clone https://github.com/jiahaoc040-ai/veriflow && cd veriflow
git show 8d07d44:docs/SCORING-v2.md | shasum -a 256         # 6c862bfe…
git show 8d07d44:gateway/src/score-v2.ts | shasum -a 256    # babc11e5…
```

On the explorer the "Data Registered" event shows the data as hex. Copy the hex and decode it:

```bash
python3 -c "print(bytes.fromhex(input('hex: ')).decode())"
# veriflow:scoring:v2:13115:08e3b49e…:6c862bfe…:babc11e5…
```

Both full hashes are in that text. Each run of the `score-v2` GitHub workflow repeats this check and fails if the files differ.

**What Path A proves.** The call was committed before its outcome, under its own asset and day. It was not changed afterwards, and it follows the published rule. It does not prove that the call is right. Nothing is scored until the exit candle closes on 2026-11-30, and the rule never prints a hit rate.

## Path B: buy a call yourself (about 30 minutes, testnet)

Two steps take most of the time: getting a testnet identity, and exporting a key to a file. Only use a testnet account with test CCD.

1. Install the **Concordium Browser Wallet** (Chrome), switch to **Testnet**, and create an identity with a test identity provider. Then create an account.
2. Get testnet CCD for that account from the wallet's testnet faucet.
3. Prove eligibility once at <https://veriflow-yrhp.onrender.com/verify>. Connect the wallet and approve the zero-knowledge proof: age 18 or over, and residence not in a restricted list. Your date of birth and country are not revealed.
4. Export the account key from the wallet (*Private key → Export*), and set up the buyer:
   ```bash
   cd veriflow/gateway && npm ci
   cp .env.example .env
   mv ~/Downloads/<your account>.export keys/buyer.export   # BUYER_KEY_FILE in .env points here
   ```
   `GATEWAY_URL` already points at the live testnet gateway.
5. Buy the BTC call:
   ```bash
   npm run buyer -- BTC
   ```
   Before signing, the buyer checks the seller:
   - agent #1313 has the Verified by Concordium badge and is Active;
   - the SHA-256 of its Agent Card matches the hash on-chain;
   - x402 `payTo` equals the agent's on-chain `agentWallet`.

   If any check fails, it refuses to pay. It then pays 1 CCD and prints the call, the commitment and the anchor transaction.
6. Verify what you bought: run Path A steps 1–3 with your own string. Or use Claude Desktop:
   ```bash
   npm run mcp:config -- --install
   ```
   Restart Claude Desktop, open a normal chat (not a Cowork task), and ask it to buy a BTC signal and verify it. `verify_signal` reads the anchor straight from a Concordium node.

If today's call is not committed yet (before about 00:10 UTC), the gateway answers 503 and nothing is charged.
