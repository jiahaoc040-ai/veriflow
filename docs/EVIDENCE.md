# Terminal transcripts

Unedited output of the runs the README and JUDGES.md describe, from the team's own machine. Refusals leave nothing on-chain (nothing is signed or broadcast), so a transcript is the only record of them; each one below can be reproduced with the command shown. Payments and bindings can be checked on-chain through the links.

## 1. Impostor seller refused before signing (2026-11-25)

A local fake seller copies #1313's Agent Card, badge and 402, and changes only `payTo`. Reproduce with `cd gateway && npm ci && npm run impostor` (no wallet needed; `src/demo-impostor.ts`).

```
$ BUYER_KEY_FILE=keys/buyer.export npm run impostor

impostor seller on http://localhost:4099: copies https://veriflow-yrhp.onrender.com's card and 402 (agent #1313, same badge), but payTo = 4HgaCRwXHYWLAbHA4NE5LD8Cv8xYvuW4hP6RACaT1xVwT3nmCj

seller check: FAILED — nothing was signed or paid
  ✓ seller advertises a Verified by Concordium badge — badge JyP9UWYKh54TD2MUJDfqC
  ✓ registered and Active in the CIS-8004 Agent Registry — agent #1313, status Active, owner 4dNMXmNKa2i5hvABfbRJ6NebGopaWSPNmMrbvroSzgJF5wjUNt (read from a Concordium node)
  ✓ official badge check passes (identity-verified owner) — 15 checks passed
  ✓ Agent Card unchanged since pinned on-chain (own SHA-256) — sha256 a9f6616c58a1e8ee4f0b37a54b9824445d19afa66b7ee46247f8d8406a699143 vs on-chain a9f6616c58a1e8ee4f0b37a54b9824445d19afa66b7ee46247f8d8406a699143
  ✗ payTo is the agent's on-chain wallet — payTo 4HgaCRwXHYWLAbHA4NE5LD8Cv8xYvuW4hP6RACaT1xVwT3nmCj, on-chain agentWallet 3WSAJwTZqVRypnGMkUjW28QDES8h1FUBoCwrzQ1rdN35NGavf8

✅ refused before signing: the impostor got nothing
```

(The card hash shown is the card pinned at that time; it was re-pinned the same day, most recently as `ee656d25…` in [`300332b5…`](https://ccdexplorer.io/testnet/transaction/300332b588e3c825af7b09c713185fcf101e6921a88571ea3c35f982f5fe4f33).)

## 2. Contract v2 rejects rule-breaking commits (2026-11-25)

The committer deliberately sent two commits that break the contract's rules; both are on-chain as rejected transactions.

```
$ COMMITTER_KEY_FILE=keys/committer.export npm run contract2 -- prove-rejection

✓ rejected by the chain — a second call for a day that already has one (BTC 2026-11-24): https://ccdexplorer.io/testnet/transaction/29ef60c50e0a1b1a8103c427c218f3f589b9f9b078982008b983b4a9c1e1c5f2
✓ rejected by the chain — a late call, three days after its close (BTC 2026-11-22): https://ccdexplorer.io/testnet/transaction/ce0623322833d6d0d6d5a2891ff7f65ca46b18b45f491483850f4419136047c6
```

## 2b. USDC on Base Sepolia, both sides bound in CIS-8 (2026-11-25)

```
$ BUYER_PAY_NETWORK=evm BUYER_AGENT_TOKEN_ID=1478 BUYER_KEY_FILE=keys/buyer.export npm run buyer -- BTC

buyer 4Vf4qUg5jWyAJXJ3mR3RHvfu8YXjiNT5asveQFF52FgkjMQ16r (agent #1478) → https://veriflow-yrhp.onrender.com/signal/BTC, paying in USDC on eip155:84532 from 0xAc0220Eb4dd8289d16D91339126b475C0ab5aCb8

seller check: passed
  ✓ seller advertises a Verified by Concordium badge — badge JyP9UWYKh54TD2MUJDfqC
  ✓ registered and Active in the CIS-8004 Agent Registry — agent #1313, status Active, owner 4dNMXmNKa2i5hvABfbRJ6NebGopaWSPNmMrbvroSzgJF5wjUNt (read from a Concordium node)
  ✓ official badge check passes (identity-verified owner) — 15 checks passed
  ✓ Agent Card unchanged since pinned on-chain (own SHA-256) — sha256 a9f6616c58a1e8ee4f0b37a54b9824445d19afa66b7ee46247f8d8406a699143 vs on-chain a9f6616c58a1e8ee4f0b37a54b9824445d19afa66b7ee46247f8d8406a699143
  ✓ payTo is bound to the agent in CIS-8 (read from a Concordium node) — 0xdd315C4383bC9aedbE18E7bD954be3718a2F8746 is bound to 4dNMXmNKa2i5hvABfbRJ6NebGopaWSPNmMrbvroSzgJF5wjUNt in CIS-8 <12801,0>

status: 200
the seller mapped our EVM payer 0xAc0220Eb4dd8289d16D91339126b475C0ab5aCb8 to Concordium account 4Vf4qUg5jWyAJXJ3mR3RHvfu8YXjiNT5asveQFF52FgkjMQ16r — payer key recovered from the EIP-3009 signature, bound in CIS-8 (read from a Concordium node) before verification and again before settlement
the seller checked us: agent #1478 — read from a Concordium node before verification and again before settlement: Active, and the payer is its agentWallet
canonical (hash exactly this string): {"as_of":"2026-11-24","asset":"BTC","momentum_e6":-253538,"nonce":"009a59c074e16178fa06adf1c2ef747d","signal":"RISK_OFF"}
commitment: 9b1014a32b925915cf173f6d8fc53d6191a436f70cc796894b9689419ba4d6fc
commit tx:  https://ccdexplorer.io/testnet/transaction/af3fc90c65a4deaa9153431018d0ff083a15705f50181626855fa084ffe14ed8
payment tx: https://base-sepolia.blockscout.com/tx/0xe48c3357d84601a51ab4caf6db73274b1d57ef797c21c9f54f80f02c875cbc44
```

## 3. CIS-8 bindings: canonical bytes checked against the official service before signing (2026-11-25)

`npm run cis8 -- bind <name>` computes the CIS-8 canonical bytes itself, compares them with the official `build_cis8_canonical_bytes` service and signs only if they are identical (`gateway/src/cis8-cli.ts`).

```
$ REGISTRY_OWNER_KEY_FILE=keys/facilitator.export CIS8_ROLE=veriflow-seller-payto npm run cis8 -- bind seller
canonical bytes match the official service (251 bytes)
submitted CIS-8.registerExternalKey: https://ccdexplorer.io/testnet/transaction/64746743a948d0d9dbbc0fafbcb8d9c5ee143fb8dbcf210cb6ebbe50627e59ce
❌ registered, but the node check failed: could not read CIS-8 from a Concordium node: CIS-8 returned a registration for a different key

$ REGISTRY_OWNER_KEY_FILE=keys/buyer.export CIS8_ROLE=veriflow-buyer npm run cis8 -- bind buyer
canonical bytes match the official service (251 bytes)
submitted CIS-8.registerExternalKey: https://ccdexplorer.io/testnet/transaction/21c76e955cc356c73e2eb3763b8c9841a01dbb1dd44f08f22b71d20da1162a5b
❌ registered, but the node check failed: could not read CIS-8 from a Concordium node: CIS-8 returned a registration for a different key
```

Both registrations succeeded. The read-back failed because the registry stores secp256k1 keys in compressed form, which our first version did not expect; fixed in `7bb2299`. The raw node answer and the official service's reading after the fix:

```
$ npm run cis8 -- raw seller
node   : 01ddaaaad8411ef3c2595d0c9c7f15023a66157665dc8249ac7c9f458ebf3a33230c0000006569703135353a383435333214000000736563703235366b312d636f6d707265737365642100000003eb45b5…
service: {"network":"testnet","owner":"4dNMXmNKa2i5hvABfbRJ6NebGopaWSPNmMrbvroSzgJF5wjUNt","external_key":{"namespace":"eip155:84532","key_type":"secp256k1-compressed","public_key_hex":"03eb45b5a140eab832a6af842209e5cb51abbd8cf6c0820fd1b94c80bd201de05c"},"proof_scheme":"ethereum-personal-sign","metadata":[{"key":"role","value":"veriflow-seller-payto"}],"status":"Active","last_updated":"2026-11-25T02:24:29.593+00:00"}

$ npm run cis8 -- show seller
{ "address": "0xdd315C4383bC9aedbE18E7bD954be3718a2F8746", "namespace": "eip155:84532",
  "registration": { "owner": "4dNMXmNKa2i5hvABfbRJ6NebGopaWSPNmMrbvroSzgJF5wjUNt", "status": "Active", "proofScheme": "ethereum-personal-sign",
    "key": { "namespace": "eip155:84532", "keyType": "secp256k1-compressed", "publicKey": "03eb45b5a140eab832a6af842209e5cb51abbd8cf6c0820fd1b94c80bd201de05c" } } }
```

## 4. CCD purchase after the card was re-pinned (2026-11-25)

```
$ BUYER_AGENT_TOKEN_ID=1478 BUYER_KEY_FILE=keys/buyer.export npm run buyer -- BTC

seller check: passed
  ✓ seller advertises a Verified by Concordium badge — badge JyP9UWYKh54TD2MUJDfqC
  ✓ registered and Active in the CIS-8004 Agent Registry — agent #1313, status Active, owner 4dNMXmNKa2i5hvABfbRJ6NebGopaWSPNmMrbvroSzgJF5wjUNt (read from a Concordium node)
  ✓ official badge check passes (identity-verified owner) — 15 checks passed
  ✓ Agent Card unchanged since pinned on-chain (own SHA-256) — sha256 bfbe4573465a8118706db384d4d636f62aaa32cf2ea33952ba8a21c2d723fd6f vs on-chain bfbe4573465a8118706db384d4d636f62aaa32cf2ea33952ba8a21c2d723fd6f
  ✓ payTo is the agent's on-chain wallet — payTo 3WSAJwTZqVRypnGMkUjW28QDES8h1FUBoCwrzQ1rdN35NGavf8, on-chain agentWallet 3WSAJwTZqVRypnGMkUjW28QDES8h1FUBoCwrzQ1rdN35NGavf8

status: 200
the seller checked us: agent #1478 — read from a Concordium node before verification and again before settlement: Active, and the payer is its agentWallet
payment tx: https://ccdexplorer.io/testnet/transaction/a7bb979f6c3d70edfed795c3e5bf6095ab669c230a09c59643c8a5205da16c70
```
