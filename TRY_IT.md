# Try VeriFlow yourself

Each step says what to run, what you should see, and what that shows.

- **Path A: about 2 minutes, no wallet.** Check a call that was really bought, against the chain and Binance. You need a terminal with `shasum` (on Linux, `sha256sum`), `curl`, `python3` and `git`, and a browser.
- **Path B: about 30 minutes.** Buy a call yourself on Concordium testnet with your own testnet identity.

Path A trusts this page for one thing only: the call string. Everything else is checked against the chain and Binance. Path B removes that trust, because you receive the string yourself.

All times are UTC. CCDExplorer shows UTC without a label; CCDScan shows your local time. A **close** is the end of a Binance daily candle: the 2026-11-21 close is at 2026-11-22 00:00.

## Path A: check a bought call (2 minutes)

On 2026-11-22 a buyer agent paid 1 testnet CCD ([payment `935bc182…`](https://ccdexplorer.io/testnet/transaction/935bc182245754dfef95661c7006beed4fd8635e8c40605c96a2ad571f7c1879)) for the BTC call for the 2026-11-21 close. It received this exact string. These are the bytes to hash, with no spaces or newlines:

```
{"as_of":"2026-11-21","asset":"BTC","momentum_e6":-260395,"nonce":"7294f91f41330af85ea8f6af86dc2f9c","signal":"RISK_OFF"}
```

### 1. Hash it

```bash
printf '%s' '{"as_of":"2026-11-21","asset":"BTC","momentum_e6":-260395,"nonce":"7294f91f41330af85ea8f6af86dc2f9c","signal":"RISK_OFF"}' | shasum -a 256
```

**You should see** `10cb3dc27d440d2e08278e7e454bd11abbb61ceffb91b34279ab28fd7d7a8eda`. That is the commitment. Change one character and the hash changes.

### 2. Find that hash on-chain

Open the commit transaction: <https://ccdexplorer.io/testnet/transaction/fe340eeaa2623405880a57208c88004fb4f12b7b56479876e8be6f24a4ada718>

**You should see:**

| On the page | Value | What it shows |
|---|---|---|
| Function / contract | `commit` on `veriflow_registry_v2` `<13115,0>`, type "contract updated" | The call went into contract v2. |
| **Parameter** | `as_of: 2026-11-21`, `asset: BTC`, commitment `10cb3dc2…8eda` | The hash from step 1 is stored under BTC, 2026-11-21. |
| Timestamp | `2026-11-22 08:03:30` (UTC; the page does not label it) | The commit came 8 hours after the 2026-11-21 close. The contract only accepts a commit for that day between 2026-11-22 00:00 and 2026-11-23 00:00. |
| Sender | account index `19719`. Click it to see `4HgaCRwX…VwT3nmCj` | The committer. The owner appointed it in [`set_committer` `6e3eb548…`](https://ccdexplorer.io/testnet/transaction/6e3eb5483acbcdbf87717649b0941812513220c52b0623cc652c80678dc7668f), whose sender, index `19527`, opens as `4dNMXmNK…`. The account page does not say that `4dNM…` owns agent #1313; the registry does (see the table below). |

The Event line below is the same data in hex. To decode it, copy the hex and run:

```bash
python3 -c "
h=bytes.fromhex(input('event hex: ')); i=1
def s():
    global i; n=int.from_bytes(h[i:i+4],'little'); v=h[i+4:i+4+n].decode(); i+=4+n; return v
a=s(); d=s(); c=h[i:i+32].hex(); t=int.from_bytes(h[i+32:i+40],'little')
print('tag',h[0],'asset',a,'as_of',d,'commitment',c,'committed_at_ms',t)"
# tag 0 asset BTC as_of 2026-11-21 commitment 10cb3dc2…8eda committed_at_ms 1795334610623
```

**Only one commit exists for BTC, 2026-11-21.** The contract rejects a second one. To see this:
- open [CCDScan testnet](https://testnet.ccdscan.io/) and search for `13115` (searching `<13115,0>` finds nothing);
- click the contract row `<13115,0>`, `veriflow_registry_v2`;
- under **Events**, each day has exactly one `commit` per asset. CCDScan says "No embedded event schema"; the readable fields are under **Message**. The BTC 2026-11-21 message carries commitment `10cb3dc2…8eda`. Times there are in your local time zone.

If you cloned the repo, you can also run `cd gateway && npm ci && npm run contract2 -- slot BTC 2026-11-21` (Node 22 or newer). It prints the same commitment, `committed_at: 2026-11-22T08:03:30.623Z` and `reveal: null`.

A rejected transaction never changes the contract, so a working rule leaves no mark in the event list. The only evidence of a rejection is the rejected transaction itself, which the explorers list separately from events.

### 3. Recompute the call from Binance

The rule is public:
- `momentum_e6` is the change from the 2026-10-22 close to the 2026-11-21 close of Binance BTCUSDT, in millionths, rounded half away from zero;
- the call is `RISK_ON` only if `momentum_e6 > 0`.

```bash
python3 - <<'EOF'
import json, urllib.request
def close(ms):   # the daily candle that OPENS at this time (UTC)
    url = f"https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1d&startTime={ms}&limit=1"
    return json.load(urllib.request.urlopen(url))[0][4]          # decimal string
def units(s):                                                     # exact, in 1e-8
    i, _, f = s.partition("."); return int(i) * 10**8 + int((f + "0" * 8)[:8])
now  = units(close(1795219200000))   # candle opening 2026-11-21 00:00
then = units(close(1792627200000))   # candle opening 2026-10-22 00:00
n, d = (now - then) * 10**6, then
m = (2 * abs(n) + d) // (2 * d) * (1 if n >= 0 else -1)          # round half away from zero
print(m, "RISK_ON" if m > 0 else "RISK_OFF")
EOF
```

**You should see** `-260395 RISK_OFF`, which matches the string from step 1.

If Binance answers HTTP 451 where you are, read the two daily closes from any BTCUSDT chart. They are 60215.77 for the candle opening 2026-11-21 and 81416.09 for the candle opening 2026-10-22. Compute `(60215.77 / 81416.09 − 1) × 1,000,000 = −260394.72…` and round half away from zero to get −260395.

The contract enforces the second half of the rule itself. When this call is revealed, it rejects any text whose `signal` contradicts its `momentum_e6`. The first half, whether `momentum_e6` equals Binance, is what you just checked. The scoring rule also checks it every day.

### 4. Check that the scoring rule was fixed before the first call

The owner registered the hashes of the rule files in [`ecadec1b…`](https://ccdexplorer.io/testnet/transaction/ecadec1b75cd764a2f87c512787cb3e5422148852760046978e2e4324d8b3271) at 2026-11-22 07:06:10. That was before the committer was appointed (07:33:20) and before the first commit (08:03:30, the BTC call above).

```bash
git clone https://github.com/jiahaoc040-ai/veriflow && cd veriflow
git show 8d07d44:docs/SCORING-v2.md | shasum -a 256
# 6c862bfec9a427da83bd4cb1482e0a61f938e4c1fc54a07861ef36fb0a93b1c0
git show 8d07d44:gateway/src/score-v2.ts | shasum -a 256
# babc11e585bfdd9e54e64832540d36669c1a1641446fb3bb3b5947922c4f6f88
```

On the explorer, the "Data Registered" event shows the data as hex. Decode it:

```bash
python3 -c "print(bytes.fromhex(input('hex: ')).decode())"
```

**You should see**:

```
veriflow:scoring:v2:13115:08e3b49e4e6d0a11f1d2af4c6754537d695cfe19945b9b6d7fb5b8722f4df6cc:6c862bfe…:babc11e5…
```

The fields are:
- `13115` is the contract;
- `08e3b49e…` is the module reference of its code (on CCDScan, the contract's module);
- the last two are the hashes you just computed.

Every run of the [`score-v2` workflow](https://github.com/jiahaoc040-ai/veriflow/actions/workflows/score-v2.yml) repeats this comparison. It runs four times a day. A run fails unless the files it scores with are exactly the registered ones, the contract was created from that module, and the registration came before the first commit. A green run means the published numbers come from the pre-registered rule.

Open a run and scroll to its summary; it is readable without signing in to GitHub. It shows the registered text it matched, commit and reveal integrity as fractions, every failure by day and asset, and the performance numbers or the reason they are not published yet. The logs and the JSON report need a GitHub login.

### Who is who

| Account | Index on the explorers | Role, and where that is recorded |
|---|---|---|
| `4dNMXmNK…JF5wjUNt` | 19527 | Owner of agent #1313 in the CIS-8004 Agent Registry `<12802,0>` (`agentOf(1313)`), and owner of contract `<13115,0>` (its creator on CCDScan). Kept offline. |
| `3WSAJwTZ…5NGavf8` | 19394 | Agent #1313's `agentWallet` in the registry. Every purchase pays here. |
| `4HgaCRwX…VwT3nmCj` | 19719 | Committer of contract `<13115,0>`, appointed by the owner in `set_committer`. It also sponsors buyers' transaction fees. |
| `4Vf4qUg5…QF52FgkjMQ16r` | 19528 | A test buyer. |

The payment page for `935bc182…` shows 1 CCD from 19528 to 19394, with fees paid by 19719. It does not name the call it paid for; the buyer receives the string in the HTTP response, which is why Path A has to trust this page for it, and Path B does not.

The README's "latest purchase" is a different, later purchase (an ETH call). Either works; this page uses the BTC one.

### What Path A shows, and what it does not

**It shows:**
- this call was committed on-chain before its outcome, under its own asset and day;
- nothing else can be stored for that slot;
- its `momentum_e6` is Binance's 30-day change;
- its label follows the rule;
- the scoring rule was fixed before the first call.

When the call is revealed (from 2026-11-29 08:03, by anyone), the contract accepts only text that hashes to `10cb3dc2…`.

**It does not show that the call is right.** The rule is public and carries no edge.

The scoring rule measures each call over the 7 days after it is committed:
- from the close of the commit's day (the candle opening 2026-11-22);
- to the close 7 days later (the candle opening 2026-11-29, which closes 2026-11-30 00:00).

It publishes the mean 7-day return of the calls against always-on and always-off. It never publishes a hit rate. The first number can appear after 2026-11-30 00:00 in the `score-v2` workflow's run summary, and only if no day has failed.

## Path B: buy a call yourself (about 30 minutes, testnet)

Two steps take most of the time: getting a testnet identity, and exporting an account key to a file. Use only a testnet account holding test CCD.

1. **Wallet and identity.**
   - Install the [Concordium Browser Wallet](https://chromewebstore.google.com/search/concordium%20wallet) in Chrome and switch it to **Testnet**.
   - Create an identity with one of the test identity providers the wallet lists, then create an account under it.
   - If the identity step fails, search the Concordium developer documentation for "browser wallet" setup.
2. **Test CCD.** Request testnet CCD for that account in the wallet; the testnet build offers a faucet. 2 CCD is enough.
3. **Prove eligibility once.**
   - Open `https://veriflow-yrhp.onrender.com/verify?account=<your account address>` and press **Prove eligibility**.
   - In the wallet, select **that same account** and approve.
   - You prove age ≥ 18 and residence not in CU, IR, KP, SY or US, without revealing either.
   - **You should see** "✅ Eligible … can now buy signals (until …)", with links to the request (VRA) and audit (VAA) transactions.
   - If your residence is on the list, the proof cannot be made and you cannot buy. That is the point of the check.
4. **Set up the buyer.**
   ```bash
   git clone https://github.com/jiahaoc040-ai/veriflow && cd veriflow/gateway
   npm ci                      # Node 22 or newer
   cp .env.example .env        # BUYER_KEY_FILE=keys/buyer.export and GATEWAY_URL (the live testnet gateway) are already set
   mkdir -p keys
   ```
   The buyer needs nothing else from `.env`. Leave `SELLER_ADDRESS`, `GATEWAY_SECRET` and the other seller settings empty; they are for running your own gateway. The comments in `.env.example` are in Chinese; the variable names are what matter.
   In the wallet, use *Accounts → your account → Private key → Export*. It downloads `<account address>.export`. Move it into place:
   ```bash
   mv ~/Downloads/<account address>.export keys/buyer.export
   ```
5. **Buy.** Run `npm run buyer -- BTC` (or `-- ETH`).

   **You should see** three things:
   - **The seller check**, with five ✓ lines:
     1. badge;
     2. agent #1313 Active, "read from a Concordium node";
     3. official badge check;
     4. Agent Card hash;
     5. `payTo` equals the on-chain wallet.
   - **The result**: `status: 200`, the `canonical` string, the `commitment`, the `commit tx` link and the `payment tx` link.
   - **On a failed seller check**, it prints ✗ and stops before anything is signed.

   It answers **503 (nothing charged)** until today's call is committed. That call is for yesterday's close. The `daily-v2` job commits it hourly from 00:17, so try again after about 01:00.
6. **Verify what you bought.** Repeat Path A steps 1–3 with your own values:
   - hash the `canonical` string exactly as printed;
   - open your `commit tx` link and check that its Parameter shows your asset, your `as_of` and your commitment;
   - for step 3, change the two candle times to your `as_of` and 30 days earlier, and the symbol for ETH.

   **Or use Claude Desktop as the buyer:**
   - Run `npm run mcp:config -- --install`. It adds a `veriflow` entry to Claude Desktop's `claude_desktop_config.json` and prints the file's path.
   - Quit Claude Desktop with ⌘Q and reopen it.
   - In a normal chat (not a Cowork task), ask: "Use VeriFlow to buy a BTC signal and verify it."
   - **Done** looks like: seller check 5/5, a payment link, and `verify_signal` 5/5. The fifth check reads "committed under this signal's own day on contract <13115,0>".
