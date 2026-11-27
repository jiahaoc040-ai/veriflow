# Try VeriFlow yourself

Each step says what to run, what you should see, and what that shows. You need Node.js 22 or newer for the `npm run` commands.

- **Path A: about 10 minutes, no wallet.** Check a call that was really bought, against the chain and Binance. You need a terminal with `shasum`, `curl`, `python3` and `git`, and a browser. The commands use `shasum -a 256`; on Linux without `shasum`, replace it with `sha256sum`. **On Windows**, run them in Git Bash (installed with Git for Windows), not PowerShell; or skip steps 1–3 with the one-command check below, which works in any shell.
- **Path B: about 30 minutes.** Buy a call yourself on Concordium testnet with your own testnet identity.

Path A trusts this page for one thing only: the call string. Everything else is checked against the chain and Binance. Path B removes that trust, because you receive the string yourself.

All times are UTC. CCDExplorer shows UTC without a label; CCDScan shows your local time. A **close** is the end of a Binance daily candle: the 2026-11-21 close is at 2026-11-22 00:00.

## Path A: check a bought call (about 10 minutes)

On 2026-11-22 a buyer agent paid 1 testnet CCD ([payment `935bc182…`](https://ccdexplorer.io/testnet/transaction/935bc182245754dfef95661c7006beed4fd8635e8c40605c96a2ad571f7c1879)) for the BTC call for the 2026-11-21 close. It received this exact string. These are the bytes to hash, with no spaces or newlines:

```
{"as_of":"2026-11-21","asset":"BTC","momentum_e6":-260395,"nonce":"7294f91f41330af85ea8f6af86dc2f9c","signal":"RISK_OFF"}
```

**One command, any OS (steps 1–3 at once):** `git clone https://github.com/jiahaoc040-ai/veriflow`, then in `veriflow/gateway` run `npm ci` and `npm run check-call`, and paste the string above when asked. It prints the commitment, reads the slot from contract `<13115,0>` on a public node, recomputes `momentum_e6` from Binance, and shows every value it used. The steps below do the same by hand.

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

**Contract v2 holds only one commit for BTC, 2026-11-21.** It rejects a second commit for the same asset and day, and a commit outside the day after the close (`contract-v2/src/lib.rs`, covered by `contract-v2/tests`). Both were tried on-chain on purpose by the committer on 2026-11-25 and rejected by the contract: [a second BTC 2026-11-24 call `29ef60c5…`](https://ccdexplorer.io/testnet/transaction/29ef60c50e0a1b1a8103c427c218f3f589b9f9b078982008b983b4a9c1e1c5f2) and [a BTC 2026-11-22 call three days late `ce062332…`](https://ccdexplorer.io/testnet/transaction/ce0623322833d6d0d6d5a2891ff7f65ca46b18b45f491483850f4419136047c6) (`npm run contract2 -- prove-rejection`). (The service's `/commitments` list also shows an older BTC 2026-11-21 entry, `ba9b801e…`, from the retired v1 system, which did not enforce one call per asset and day; that is why v2 replaced it.) To see this:
- open [CCDScan testnet](https://testnet.ccdscan.io/) and type `13115` in the search box (searching `<13115,0>` finds nothing);
- the suggestions show two rows: a block `6b645d @ 13115` ("Age over 4 years"), and the contract `<13115,0>` created by `4dNMXm`. Click the **contract** row (pressing Enter does not open it). Its page names it `veriflow_registry_v2`. CCDScan shortens the module to `08e3b4`; hover over it for the full hash, or open [the contract on CCDExplorer](https://ccdexplorer.io/testnet/contract/13115/0);
- under **Events**, each day has exactly one `commit` per asset. CCDScan says "No embedded event schema"; the readable fields are under **Message**. The BTC 2026-11-21 message carries commitment `10cb3dc2…8eda`. Times there are in your local time zone.

If you cloned the repo, you can also run `cd gateway && npm ci && npm run contract2 -- slot BTC 2026-11-21` (Node 22 or newer). It needs no key and no `.env`; it reads Concordium's public testnet node. It prints the same commitment, `committed_at: 2026-11-22T08:03:30.623Z` and `reveal: null`. An error such as `ECONNRESET` or a timeout means the public node dropped the connection; run it again.

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

The contract enforces the second half of the rule itself. When this call is revealed, it rejects any text whose `signal` contradicts its `momentum_e6`. The first half, whether `momentum_e6` equals Binance, is what you just checked. The scoring workflow checks it for each call once the call is revealed, 7 days after its close; until then its report shows `0 / 0` reveals.

### 4. Check that the scoring rule was fixed before the first call

The owner registered the hashes of the rule files in [`ecadec1b…`](https://ccdexplorer.io/testnet/transaction/ecadec1b75cd764a2f87c512787cb3e5422148852760046978e2e4324d8b3271) at 2026-11-22 07:06:10. That was before the committer was appointed (07:33:20) and before the first commit (08:03:30, the BTC call above).

```bash
git clone https://github.com/jiahaoc040-ai/veriflow && cd veriflow   # a full clone: --depth 1 drops commit 8d07d44
git show 8d07d44:docs/SCORING-v2.md > rule.md && shasum -a 256 rule.md
# 6c862bfec9a427da83bd4cb1482e0a61f938e4c1fc54a07861ef36fb0a93b1c0
git show 8d07d44:gateway/src/score-v2.ts > rule.ts && shasum -a 256 rule.ts
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

Every run of the [`score-v2` workflow](https://github.com/jiahaoc040-ai/veriflow/actions/workflows/score-v2.yml) repeats this comparison. It is scheduled four times a day; GitHub delays or skips scheduled runs, so in practice the gap can be longer. A run fails unless the files it scores with are exactly the registered ones, the contract was created from that module, and the registration came before the first commit. A green run means the published numbers come from the pre-registered rule.

GitHub hides run summaries and logs from visitors who are not signed in, so every run also publishes its result to the [`score-reports` branch](https://github.com/jiahaoc040-ai/veriflow/tree/score-reports/score-v2): `README.md` there is the latest result in plain words, `latest.json` the full report, and `history/` every run since publishing started (2026-11-23 06:05 UTC). Each result shows the registered text it matched, commit and reveal integrity as fractions, every failure by day and asset, and the performance numbers or the reason they are not published yet, with a link to the run and the commit it ran.

### Who is who

| Account | Index on the explorers | Role, and where that is recorded |
|---|---|---|
| `4dNMXmNK…JF5wjUNt` | 19527 | Owner of agent #1313 in the CIS-8004 Agent Registry `<12802,0>` (`agentOf(1313)`), and owner of contract `<13115,0>` (its creator on CCDScan). Kept offline. |
| `3WSAJwTZ…5NGavf8` | 19394 | Agent #1313's `agentWallet` in the registry. Every purchase pays here. |
| `4HgaCRwX…VwT3nmCj` | 19719 | Committer of contract `<13115,0>`, appointed by the owner in `set_committer`. Until 2026-11-24 it also sponsored buyers' transaction fees; since then Concordium's hosted facilitator does (account 19003). |
| `4Vf4qUg5…QFF52FgkjMQ16r` | 19528 | A test buyer. |

To check the first two rows yourself:
- owner: [Concordium's badge check for #1313](https://agent-registry-mcp.concordium.com/v1/badge-check/JyP9UWYKh54TD2MUJDfqC) (hosted by Concordium) shows owner `4dNMXmNK…JF5wjUNt`, Active, and the Agent Card hash;
- wallet: the owner bound it in [`setAgentWallet` `8238b866…`](https://ccdexplorer.io/testnet/transaction/8238b866de05398d95fd66be64a74b1f0e86279cd2b748838ebaa5fd4e44e33b) on the registry contract `<12802,0>`, sent by 19527, with `new_wallet: 3WSAJwTZ…5NGavf8`. The page shows `token_id: 2105000000000000`: that is 1313 written as 8 little-endian bytes (`0x0521` = 1313; check with `python3 -c "print(int.from_bytes(bytes.fromhex('2105000000000000'),'little'))"`);
- both at once, straight from the chain: from the cloned repo, `cd gateway && npm run agent -- 1313` calls `agentOf(1313)` on `<12802,0>` through the public node and prints owner, wallet, Agent Card location and hash, and status.

The payment page for `935bc182…` shows 1 CCD from 19528 to 19394, with fees paid by 19719. It does not name the call it paid for; the buyer receives the string in the HTTP response, which is why Path A has to trust this page for it, and Path B does not.

The README's "latest purchase" sections describe later purchases (BTC calls for the 2026-11-23 and 2026-11-24 closes). Any of them works; this page uses the earliest.

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
   - Use the **browser** wallet; the mobile wallet over WalletConnect fails with "Unsupported method" for these signatures.
   - Install the [Concordium Wallet](https://chromewebstore.google.com/search/concordium%20wallet) extension in Chrome (the store calls it "Concordium Wallet"). Its first screen sets a passcode.
   - It starts on **Mainnet**. Switch to **Testnet** with the small network label at the top right of the "Create or Restore Account" screen.
   - Create an identity with **Concordium testnet IP**. Keep the form's defaults (born 1970-01-01, resident in DK) and do **not** tick "Fail identity"; those defaults pass the eligibility check in step 3. Then create an account under it.
   - If the identity step fails, search the Concordium developer documentation for "browser wallet" setup.
2. **Test CCD.** In the wallet, *Activity → Request CCD* gives 20,000 test CCD, once per account. The wallet shows a euro value next to it; it is still testnet CCD. You need about 2.
3. **Prove eligibility once.**
   - Open `https://veriflow-yrhp.onrender.com/verify`, press **Use wallet's account** (or paste your full address: the wallet shows it shortened, the full one is under *Receive*), and press **Prove eligibility**.
   - In the wallet, select **that same account** and approve.
   - You prove age ≥ 18 and residence not in CU, IR, KP, SY or US, without revealing either.
   - **You should see** "✅ Eligible … can now buy signals (until …)", with links to the request (VRA) and audit (VAA) transactions.
   - If your residence is on the list, the proof cannot be made and you cannot buy. That is the point of the check.
   - If the page shows "Not eligible" right after you approved, reload it: the status line comes from the server. (A page bug did this until 2026-11-25; fixed.)
4. **Set up the buyer.**
   ```bash
   git clone https://github.com/jiahaoc040-ai/veriflow && cd veriflow/gateway
   npm ci                      # Node 22 or newer
   cp .env.example .env        # BUYER_KEY_FILE=keys/buyer.export and GATEWAY_URL (the live testnet gateway) are already set
   mkdir -p keys
   ```
   Windows PowerShell (no `&&` in PowerShell 5.1):
   ```powershell
   git clone https://github.com/jiahaoc040-ai/veriflow; cd veriflow\gateway
   npm ci
   Copy-Item .env.example .env
   New-Item -ItemType Directory -Force keys
   ```
   If a later `git pull` stops with `detected dubious ownership` (a repo on a second Windows drive, such as `D:`, whose file system records no owner), run `git config --global --add safe.directory D:/path/to/veriflow` once.
   The buyer needs nothing else from `.env`. Leave `SELLER_ADDRESS`, `GATEWAY_SECRET` and the other seller settings empty; they are for running your own gateway.
   In the wallet, use *Accounts → your account → Private key → Export*. It downloads `<account address>.export`; find it first (`ls ~/Downloads/*.export`, or `Get-ChildItem $HOME\Downloads\*.export` in PowerShell), then move it into place:
   ```bash
   mv ~/Downloads/<account address>.export keys/buyer.export
   ```
   (PowerShell: `Move-Item $HOME\Downloads\<account address>.export keys\buyer.export`.) The key file stays on your machine; never send it to anyone.
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

   If it answers `status: 402` with `expiry_too_far_in_future`, your computer's clock runs fast: the payment's expiry is set from it. Sync the clock (Windows: *Settings → Time & language → Date & time → Sync now*) and run again; nothing was charged. Since 2026-11-25 the seller allows about a minute of skew.

   It answers **503 (nothing charged)** until today's call is committed. That call is for yesterday's close. The `daily-v2` job is scheduled hourly from 00:17, but GitHub delays scheduled runs: the commit time varies from day to day (see the [`daily-v2` runs](https://github.com/jiahaoc040-ai/veriflow/actions/workflows/daily-v2.yml)). If you get 503, try again later; the contract accepts the commit until 24:00 UTC.
   **Optional: buy as a registered agent, and watch the seller check you back.**
   If your account owns an agent in the Agent Registry (`npm run registry -- register`, then `set-uri` and `set-wallet` with `REGISTRY_OWNER_KEY_FILE` and `SELLER_KEY_FILE` set to your key file and `SELLER_ADDRESS` empty), run `BUYER_AGENT_TOKEN_ID=<your id> npm run buyer -- BTC`.
   - **You should see** the five ✓ lines, then `the seller checked us: agent #<id> — read from a Concordium node before verification and again before settlement: Active, and the payer is its agentWallet`.
   - **To see an impersonation refused**, name someone else's agent: `BUYER_AGENT_TOKEN_ID=1313 npm run buyer -- BTC`. You get `status: 402`, `buyer_agent_check_failed:wallet_mismatch`, and nothing is charged, because #1313's on-chain `agentWallet` is not your account.
   - Our own run of both, on 2026-11-24: buyer agent #1478 was accepted and paid in [`515226b5…`](https://ccdexplorer.io/testnet/transaction/515226b587ccb056f3e1c406fe1a85e12382a6a19c61345ef41c821395289b88); the same account claiming #1313 was refused before its payment was submitted, so nothing was charged.

   **The seller re-checks your eligibility proof at every payment** (before verification and again before settlement). A paid response shows it: `the seller re-checked our eligibility proof`, with the links to your proof request (VRA) and audit record (VAA) and how long the proof stays valid.

   **Optional: pay through the escrow contract.** `npm run escrow -- check 1313`, then `npm run escrow -- pay 1313 1 10 "my test"` (1 CCD, a 10-minute window), then `npm run escrow -- release <the escrow id it printed>`. The release transaction on CCDExplorer shows the contract calling `CIS-8004.agentOf` and then paying 19394. An outside tester did this on Windows on 2026-11-27: pay [`15f9ab08…`](https://ccdexplorer.io/testnet/transaction/15f9ab08299926abfd90712ff902403c6cdbc3c18c5e4309b5b7f0746122d573), release [`240c23b2…`](https://ccdexplorer.io/testnet/transaction/240c23b2a3115a3f0bf090dc1056ffaeb46274f1cd23f27832b6a4f4c4c2cb72) (sender 19836).

6. **Verify what you bought.** Run `npm run check-call` and paste your `canonical` string: it does Path A steps 1–3 for your call. Your `as_of` is the UTC day before the day you bought (the latest close). Or repeat Path A steps 1–3 by hand with your own values:
   - hash the `canonical` string exactly as printed;
   - open your `commit tx` link and check that its Parameter shows your asset, your `as_of` and your commitment;
   - for step 3, change the two candle times to your `as_of` and 30 days earlier (milliseconds since 1970 at 00:00 UTC: `python3 -c "import datetime as d;t=d.datetime(2026,11,24,tzinfo=d.timezone.utc);print(int(t.timestamp()*1000), int((t-d.timedelta(days=30)).timestamp()*1000))"`), and the symbol for ETH.

   **Or use Claude Desktop as the buyer:**
   - Run `npm run mcp:config -- --install`. It adds a `veriflow` entry to Claude Desktop's `claude_desktop_config.json` and prints the file's path.
   - Quit Claude Desktop completely (macOS: ⌘Q; Windows: right-click the tray icon → Quit) and reopen it.
   - In a normal chat (not a Cowork task), ask: "Use VeriFlow to buy a BTC signal and verify it."
   - **Done** looks like: seller check 5/5, a payment link, and `verify_signal` 5/5. The fifth check reads "committed under this signal's own day on contract <13115,0>".
