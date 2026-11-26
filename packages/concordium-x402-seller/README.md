# concordium-x402-seller

The seller side of x402 on Concordium: before you take an agent's money, check **who is paying** on Concordium. Attach it to the `x402ResourceServer` you already have:

```ts
import { x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { ExactConcordiumScheme } from "@x402/concordium/exact/server";
import { concordiumSeller, sellerAgentExtension, NETWORKS } from "concordium-x402-seller";

const server = new x402ResourceServer(facilitator).register(NETWORKS.testnet.caip2, new ExactConcordiumScheme());
concordiumSeller(server, { network: "testnet", eligibility, buyerAgent: "optional", verifyUrl: "https://you.example/verify" });
app.use(paymentMiddleware(routes, server));
```

```bash
npm install concordium-x402-seller @x402/core
```

ESM only, Node 22 or newer. It is the code [VeriFlow](https://github.com/jiahaoc040-ai/veriflow)'s live seller runs (`gateway/src`), with the network, node and anchoring account passed in instead of read from its config.

## What it checks

| When | Check | Read from |
|---|---|---|
| Before verification | The buyer's **Verify & Access** zero-knowledge proof (for example: 18 or older, not resident in a restricted country) is re-checked for this payment, never from a cache: the stored proof against the current policy and identity provider list, the SDK's official check again, both anchors sent by your account, and the credential still owned by the payer | a Concordium node |
| Before verification | A buyer agent named in the `X-Concordium-Agent` header is Active in the CIS-8004 Agent Registry and its on-chain `agentWallet` is the paying account (policy `off`, `optional` or `required`) | a Concordium node |
| Before settlement | The buyer agent again, read fresh: an agent revoked or re-pointed between verification and settlement is refused before the money moves | a Concordium node |
| Settlement reported as failed | The reported transaction is read from a node and treated as settled only if it is finalized, successful, from the payer, and pays exactly the price to `payTo` (CCD, or a PLT by token id). Concordium's hosted testnet facilitator has reported "transaction not found" for transfers that finalized; without this the buyer pays and gets nothing | a Concordium node |
| After settlement | Each settlement transaction is delivered against once, so the same signed payment sent in many requests at once is delivered once | your ledger (memory by default) |

Only payments on the configured Concordium network are touched. Everything that fails refuses the payment (the buyer is not charged), with a reason code such as `buyer_proof_required` or `buyer_agent_check_failed:wallet_mismatch`.

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

The flow: `challenge` builds a verification request bound to the account and anchors its hash on-chain (VRA); the buyer's Concordium wallet proves against it; `verify` runs the cheap checks first (one account credential of that account, conditions at least as strict, issuer on the chain's list), then the SDK's official check, anchors the audit record (VAA) and allow-lists the account for 30 days. A wallet page that drives this flow: VeriFlow's [`verify.html`](https://github.com/jiahaoc040-ai/veriflow/blob/main/gateway/public/verify.html). Each `challenge` pays for an anchor, so put a rate limit in front of it. For Postgres, use `sqlPersistence(query)` and `sqlLedger(run)` with your own driver.

## Tell buyers which agent they pay

```ts
const routes = { "GET /thing": { accepts: [...], extensions: sellerAgentExtension({ network: "testnet", tokenId: 1313, badge: "JyP9…" }) } };
```

That is the 402's `concordium-agent` extension, which the buyer-side [`concordium-x402-guard`](https://www.npmjs.com/package/concordium-x402-guard) reads to check exactly this agent before it signs: its badge, Active, Agent Card hash, and `payTo` = its on-chain `agentWallet`. Together the two packages check both sides of a payment on Concordium.

## Networks

`network: "testnet"` (default) or `"mainnet"`: the CIS-8004 registry (`<12802,0>` / `<10082,0>`), the x402 network id and the DID network for Verify & Access. Pass your own node with `grpc`. Some networks block port 20000.

Tests: 32 unit tests, no network (`npm test`), run in CI. MIT.
