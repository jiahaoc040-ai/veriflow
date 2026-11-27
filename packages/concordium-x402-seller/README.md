# concordium-x402-seller

The seller side of x402 on Concordium: before you take an agent's money, check **who is paying** on Concordium. Attach it to the `x402ResourceServer` you already have:

```ts
import express from "express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { ExactConcordiumScheme } from "@x402/concordium/exact/server"; // server, not /exact/client
import { concordiumSeller, NETWORKS } from "concordium-x402-seller";

const facilitator = new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL! }); // must support Concordium: see below
const server = new x402ResourceServer(facilitator).register(NETWORKS.testnet.caip2, new ExactConcordiumScheme());
concordiumSeller(server, { network: "testnet" }); // the minimum; eligibility, verifyUrl and grpc are optional (below)

const routes = {
  "GET /premium": {
    accepts: { scheme: "exact", network: NETWORKS.testnet.caip2, payTo: process.env.PAY_TO!, price: { asset: "CCD", amount: "1000000" } }, // 1 CCD
  },
};
const app = express();
app.use(paymentMiddleware(routes, server));
app.get("/premium", (_req, res) => res.json({ ok: true }));
app.listen(4021);
```

Options: `network` (`"testnet"` default), `eligibility` and `verifyUrl` (buyer proofs, below), `buyerAgent` (`"optional"` default), `grpc` (your node), `ledger` (default in memory), `recover` (default on), `inFlight`. All optional.

**A complete seller that compiles** (Express, one paid route, the eligibility endpoints, all imports): [`examples/express-seller.ts`](https://github.com/jiahaoc040-ai/veriflow/blob/main/packages/concordium-x402-seller/examples/express-seller.ts). It is type-checked in CI.

```bash
npm install concordium-x402-seller @x402/core @x402/express @x402/concordium @concordium/web-sdk express
npm install -D @types/express
```

Before you start:

- **ESM only, Node 22 or newer.** Set `"type": "module"` in your package.json (a default `npm init` project is CommonJS, and `import` then fails).
- **A facilitator that supports Concordium.** The default x402.org facilitator does not, and the first request fails with `Facilitator does not support scheme "exact" on network "ccd:…"`. Concordium runs one for testnet; ask them for the URL and an API key, and pass it to `HTTPFacilitatorClient` as in the example.
- **Price in CCD as `{ asset: "CCD", amount: "1000000" }`** (micro-CCD). A plain `"1"` or `1` is priced in the scheme's default token (USDR), not CCD. A PLT is `{ asset: "<token id>", amount: "<smallest unit>" }`.
- **`network` means two things.** `concordiumSeller({ network: "testnet" })` takes `"testnet"` or `"mainnet"`; routes and `register()` take the CAIP-2 id, `NETWORKS.testnet.caip2`.

It is the code [VeriFlow](https://github.com/jiahaoc040-ai/veriflow)'s live seller runs (`gateway/src`), with the network, node and anchoring account passed in instead of read from its config.

## What it checks

| When | Check | Read from |
|---|---|---|
| Before verification, and again before settlement | The buyer's **Verify & Access** zero-knowledge proof (only if you pass `eligibility`) (for example: 18 or older, not resident in a restricted country) is re-checked for this payment, never from a cache: the stored proof against the current policy and the identity provider list read from the node now, the SDK's official check again, both anchors sent by your account, and the credential still owned by the payer | a Concordium node |
| Before verification, and again before settlement | A buyer agent named in the `X-Concordium-Agent` header is Active in the CIS-8004 Agent Registry and its on-chain `agentWallet` is the paying account. `buyerAgent`: `"off"`, `"optional"` (default: checked when the header is sent, a buyer without it is sold to), `"required"` (registered agents only) | a Concordium node |
| Settlement reported as failed | If the facilitator's error names the transaction (in its `transaction` field or its message), that transaction is read from a node and treated as settled only if it is finalized, a plain CCD transfer (or a PLT token update) sent by the payer, paying exactly the price to `payTo`. Concordium's hosted testnet facilitator has reported "transaction not found" for transfers that finalized; without this the buyer pays and gets nothing. An error with no transaction hash (a timeout, say) is not recovered: there is nothing to read | a Concordium node |
| After settlement | Each settlement transaction is delivered against once, so the same signed payment sent in many requests at once is delivered once | your ledger |

Only payments on the configured Concordium network are touched. Everything that fails refuses the payment (the buyer is not charged). The buyer sees only a reason code, such as `buyer_proof_required` or `buyer_agent_check_failed:wallet_mismatch`, so advertise where to verify in each route's price: `extra: buyerRequirementsExtra({ verifyUrl, policy: eligibility.describe() })`.

**The ledger.** `memoryLedger()` (the default) forgets everything on restart, so after a restart an old settlement could be delivered again. Anything beyond a demo should pass `ledger: sqlLedger(run)`, one table shared by every process that sells to the same `payTo`:

```ts
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
// CREATE TABLE delivered_payments (tx TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT now())
const ledger = sqlLedger(async (sql, params) => (await pool.query(sql, params)).rowCount ?? 0);
```

`claim(tx)` returns true when this delivery may go ahead, false when that transaction was already delivered against. If the ledger itself fails, the payment is delivered (the money has moved; the ledger only stops duplicates).

## Buyer eligibility (Verify & Access V1)

```ts
import { ConcordiumGRPCNodeClient, credentials } from "@concordium/web-sdk/nodejs";
import { EligibilityService, EligibilityStore, concordiumChain, anchorAccountFromExport, filePersistence, eligibilityHandlers, NETWORKS } from "concordium-x402-seller";

const grpc = new ConcordiumGRPCNodeClient("grpc.testnet.concordium.com", 20000, credentials.createSsl());
const anchor = anchorAccountFromExport(readFileSync(process.env.ANCHOR_KEY_FILE!, "utf8")); // pays for the two anchors
const store = await new EligibilityStore(filePersistence("data/eligible.json")).init();
const eligibility = new EligibilityService({ minAge: 18, restrictedCountries: ["US", "KP"] }, store, concordiumChain({ grpc, anchor, did: NETWORKS.testnet.did }), NETWORKS.testnet.did);

const http = eligibilityHandlers(eligibility);
app.post("/eligibility/challenge", async (req, res) => { const r = await http.challenge(req.body); res.status(r.status).json(r.body); });
app.post("/eligibility/verify", async (req, res) => { const r = await http.verify(req.body); res.status(r.status).json(r.body); });
app.get("/eligibility/:account", (req, res) => { const r = http.status(req.params.account); res.status(r.status).json(r.body); });
```

`ANCHOR_KEY_FILE` is the seller's own account that pays for the two anchors, not a buyer's key. `did` is `"Testnet"` or `"Mainnet"` (`NETWORKS.testnet.did`). Postgres instead of a file: `sqlPersistence(async (sql, params) => (await pool.query(sql, params)).rows)` with `CREATE TABLE eligibility (account TEXT PRIMARY KEY, record JSONB NOT NULL)`.

The flow: `challenge` builds a verification request bound to the account and anchors its hash on-chain (VRA); the buyer's Concordium wallet proves against it; `verify` runs the cheap checks first (one account credential of that account, conditions at least as strict, issuer on the chain's list), then the SDK's official check, anchors the audit record (VAA) and allow-lists the account for 30 days. A wallet page that drives this flow: VeriFlow's [`verify.html`](https://github.com/jiahaoc040-ai/veriflow/blob/main/gateway/public/verify.html). `challenge` and `verify` each pay for an anchor, so put a rate limit in front of both.

## Tell buyers which agent they pay

```ts
// in a route config, beside accepts (not inside extra): the full badge string, as your agent's badge check shows it
extensions: sellerAgentExtension({ network: "testnet", tokenId: 1313, badge: "JyP9UWYKh54TD2MUJDfqC" }),
```

That is the 402's `concordium-agent` extension, which the buyer-side [`concordium-x402-guard`](https://www.npmjs.com/package/concordium-x402-guard) reads to check exactly this agent before it signs: its badge, Active, Agent Card hash, and `payTo` = its on-chain `agentWallet`. Together the two packages check both sides of a payment on Concordium.

## Networks

`network: "testnet"` (default) or `"mainnet"`: the CIS-8004 registry (`<12802,0>` / `<10082,0>`), the x402 network id and the DID network for Verify & Access. Pass your own node with `grpc`. Some networks block port 20000.

Buyers name their agent with the `X-Concordium-Agent: <token id>` header; with [`concordium-x402-guard`](https://www.npmjs.com/package/concordium-x402-guard): `guarded.fetch(url, { headers: { "X-Concordium-Agent": "1478" } })`.

## Changes

0.1.2: from an outside review. The same signed payment sent in parallel no longer runs the route handler more than once (each (sender, nonce) is held from verify to the end of settlement; `inFlight`, `paymentKeyOf`); with buyer checks on, a payment offered on another network is refused (`network_not_checked`) instead of skipping the checks; a recovery is not made when the ledger is unavailable; a Concordium settlement with no transaction is not delivered. README: a complete minimal seller with imports.

0.1.1: the buyer's proof is also re-checked before settlement; the identity provider list is read fresh at payment; recovery accepts only a plain CCD transfer or a token update sent by the payer, counts PLT by net amount, finds the hash in the error message, and delivers when the ledger is down; the memory ledger never forgets while running; "no such account" only on gRPC NOT_FOUND; a broken expiry date counts as expired; anchors wait for the node's nonce or refuse; an unreadable X-Concordium-Agent header refuses; `buyerRequirementsExtra`; `NETWORKS.*.caip2` typed for `register()`; a complete example. Thanks to an outside review for each.

Tests: 40 unit tests, no network (`npm test`), plus the example type-checked (`npm run check:examples`), in CI. MIT.
