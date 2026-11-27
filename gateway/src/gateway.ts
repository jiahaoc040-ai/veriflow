/**
 * VeriFlow x402 payment gateway
 * ---------------------
 * GET /signal/:asset requires payment first (x402, Concordium testnet CCD; optionally a PLT or USDC on Base).
 * After the payment is verified, the request is forwarded to the Python API with a shared secret; the API accepts only that secret,
 * so nobody can bypass the gateway and get a signal without paying.
 *
 * Public endpoints (/track-record, /commitments, /health) are forwarded for free.
 *
 * Buyer eligibility: before paying, the buyer account must prove at /verify with a Concordium wallet, in zero knowledge,
 * that it is 18+ and not resident in a restricted country. Payments from unverified accounts are refused and not charged.
 *
 * Run: npm run gateway   (default http://localhost:4020)
 */
import { AGENT_REGISTRY, readAgent } from "./registry-node.js";
import { AGENT_EXTENSION } from "./counterparty.js";
import { NET, checkGenesis } from "./network.js";
import { createGrpc } from "./grpc.js";
import { BlockHash } from "@concordium/web-sdk";
import express from "express";
import { rateLimit as baselineLimit } from "express-rate-limit";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { AfterSettleAbortError, HTTPFacilitatorClient } from "@x402/core/server";
import { AccountAddress } from "@concordium/web-sdk";
import { memoryLedger, postgresLedger, singleFlight } from "./once.js";
import { ExactConcordiumScheme } from "@x402/concordium/exact/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { CIS8_REGISTRY, EVM_KEY_TYPE, checkEvmBinding, evmAddressOf } from "./cis8.js";
import { concordiumAccountOfEvmPayment, isEvmNetwork } from "./evm-payer.js";
import { sameAccount } from "./contract-v2.js";
import { GATEWAY_DIR, NETWORK, env } from "./config.js";
import { resolve } from "node:path";
import { createAnchorer } from "./anchor.js";
import { startDailySignals } from "./daily.js";
import { mountRemoteMcp } from "./mcp-http.js";
import { mountA2A } from "./a2a.js";
import { RateLimiter, clientKey, inlineScriptHashes, isSelfCall, publicMessage, rateLimit, securityHeaders, trustProxySetting } from "./security.js";
import { demoBuyRouter, demoDisabledRouter, postgresCounter } from "./demo-buy.js";
import { escrowChain, escrowDemoDisabledRouter, escrowDemoRouter } from "./demo-escrow.js";
import { EXPECTED_MODULE as ESCROW_MODULE } from "./escrow.js";
import { guardPresetRouter } from "./guard-presets.js";
import { checkSellerAt as pkgCheckSellerAt, concordiumGuardDeps as pkgGuardDeps, NETWORKS as PKG_NETWORKS } from "concordium-x402-guard";
import { guardDeps } from "./guard-deps.js";
import { paidOnChain, paidOnEvm } from "./settle-recovery.js";
import { BUYER_AGENT_HEADER, checkBuyerAgent, parsePolicy, type BuyerAgentResult } from "./buyer-agent.js";
import { inFlight, paymentKeyOf } from "./inflight.js";
import { EligibilityService, EligibilityStore, filePersistence, postgresPersistence, MIN_AGE, concordiumChain, parseCountries, payerOf } from "./eligibility.js";

const API_URL = env("API_URL", "http://127.0.0.1:8000");
const GATEWAY_SECRET = env("GATEWAY_SECRET");
const AGENT_BADGE = env("AGENT_BADGE", "JyP9UWYKh54TD2MUJDfqC");
const AGENT_TOKEN_ID = env("AGENT_TOKEN_ID", "1313");
const PAY_TO = env("SELLER_ADDRESS");
const PRICE_MICROCCD = env("PRICE_MICROCCD", "1000000"); // 1 CCD
// Optional: the same signal can be paid in Protocol-Level Tokens, e.g. PLT_PRICE=EUDemo:1000000,hh-VFUSD:1000000 (1 unit each, 6 decimals)
// The buyer picks, from the 402's accepts, the option its own spend controls allow
const PLT_PRICES = (process.env.PLT_PRICE ?? "")
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean)
  .map((v) => {
    const m = /^([A-Za-z][A-Za-z0-9-]{1,10}[A-Za-z0-9]):(\d{1,20})$/.exec(v);
    if (!m) throw new Error("PLT_PRICE must look like EUDemo:1000000 or EUDemo:1000000,hh-VFUSD:1000000 (token id and amount in the token's smallest unit)");
    return { asset: m[1], amount: m[2] };
  });

const PUBLIC_URL = env("PUBLIC_URL", "http://localhost:4020");

// Optional: cross-chain payment. SELLER_EVM_PUBLIC_KEY is the seller's EVM payout key (bound in CIS-8 under #1313's owner); payTo is derived from it.
// EVM_PRICE_USD is the USDC price (default 0.01). Before paying, the buyer reads CIS-8 from a Concordium node to confirm the key belongs to this agent.
const EVM = (() => {
  const pk = (process.env.SELLER_EVM_PUBLIC_KEY ?? "").trim();
  if (!pk) return undefined;
  const price = env("EVM_PRICE_USD", "0.01");
  if (!/^\d{1,6}(\.\d{1,6})?$/.test(price)) throw new Error("EVM_PRICE_USD must be a decimal like 0.01");
  return { network: NET.evm.network, publicKey: pk.startsWith("0x") ? pk : `0x${pk}`, payTo: evmAddressOf(pk), price: `$${price}`, facilitator: env("FACILITATOR_EVM_URL", "https://x402.org/facilitator") };
})();

const eligibility = new EligibilityService(
  { minAge: MIN_AGE, restrictedCountries: parseCountries(process.env.RESTRICTED_COUNTRIES) },
  // Deployed: DATABASE_URL (Postgres); locally: a JSON file
  await new EligibilityStore(
    process.env.DATABASE_URL
      ? postgresPersistence(process.env.DATABASE_URL)
      : filePersistence(resolve(GATEWAY_DIR, env("ELIGIBILITY_FILE", "data/eligibility.json"))),
  ).init(),
  // The verification request (VRA) and audit record (VAA) are anchored by the anchoring account, which pays the fee
  concordiumChain(env("ANCHOR_KEY_FILE", env("FACILITATOR_KEY_FILE"))),
  PUBLIC_URL,
);
const REQUIRE_ELIGIBILITY = env("REQUIRE_ELIGIBILITY", "true") !== "false";
const BUYER_AGENT_POLICY = parsePolicy(process.env.BUYER_AGENT);
// The fake on-chain record is only for the buyer's integration tests; the seller refuses to start if it is set, so verification cannot be bypassed
if (process.env.VERIFLOW_TEST_AGENT_RECORD) {
  console.error("❌ VERIFLOW_TEST_AGENT_RECORD is set; it replaces registry reads and must never be set on the gateway");
  process.exit(1);
}

// The free host has 512 MB: with EMBED_FACILITATOR=1 the facilitator runs in the same Node process (saves about 130 MB).
// It must start and be listening before the payment middleware is created, or the middleware's /supported query fails at startup.
if (process.env.EMBED_FACILITATOR) await (await import("./facilitator.js")).listening;

// Set once a node has confirmed the chain (checkNetwork below); payments are refused before that
let networkConfirmed = false;
// Each settlement transaction is delivered against once (see once.ts): a recovered "failed" settlement must not re-deliver a paid one
const ledger = process.env.DATABASE_URL ? postgresLedger(process.env.DATABASE_URL) : memoryLedger();
const resourceServer = new x402ResourceServer([
  new HTTPFacilitatorClient({
    url: env("FACILITATOR_URL", "http://localhost:4021"),
    // Concordium's hosted testnet facilitator needs an API key. The key lives only in an environment variable: never in the repo or the logs
    ...(process.env.FACILITATOR_API_KEY
      ? {
          createAuthHeaders: async () => {
            const name = process.env.FACILITATOR_AUTH_HEADER || "Authorization";
            const scheme = process.env.FACILITATOR_AUTH_SCHEME ?? (name.toLowerCase() === "authorization" ? "Bearer" : "");
            const h = { [name]: scheme ? `${scheme} ${process.env.FACILITATOR_API_KEY}` : String(process.env.FACILITATOR_API_KEY) };
            return { verify: h, settle: h, supported: h };
          },
        }
      : {}),
  }),
  // EVM (Base) payments settle through the public x402 facilitator; it only settles on-chain, who may buy is still decided by the checks below
  ...(EVM ? [new HTTPFacilitatorClient({ url: EVM.facilitator })] : []),
])
  .register(NETWORK, new ExactConcordiumScheme());
if (EVM) resourceServer.register(EVM.network as `${string}:${string}`, new ExactEvmScheme());

/**
 * Which Concordium account a payment belongs to:
 *  - CCD / PLT: the payment transaction's sender
 *  - Base USDC: recover the payer's public key from the EIP-3009 signature, then read CIS-8 from a node to see which account it is bound to
 */
async function payerAccount(paymentPayload: { payload: unknown }, requirements: { network: string; asset: string; payTo: string; amount: string; extra?: Record<string, unknown> }) {
  if (!isEvmNetwork(requirements.network)) {
    const a = payerOf(paymentPayload.payload);
    return a ? { ok: true as const, account: a } : { ok: false as const, code: "no_payer", reason: "no payer in the payment" };
  }
  const r = await concordiumAccountOfEvmPayment(paymentPayload.payload, requirements);
  return r.ok ? { ok: true as const, account: r.account, evm: r.from } : r;
}

// One signed Concordium payment in flight at a time, from verify to the end of settlement: (sender, nonce) is unique on-chain,
// and a facilitator's verify only checks the nonce is next, so parallel copies would each run the handler (outside review)
const paymentsInFlight = inFlight();

resourceServer
  // Before the payment is sent for settlement: if the sender is not eligible, refuse (the transaction never reaches the chain, the buyer is not charged)
  .onBeforeVerify(async ({ paymentPayload, requirements, transportContext }) => {
    // Until a node has confirmed it is on the expected chain, take no payment (the site stays up, the shop is closed)
    if (!networkConfirmed) return { abort: true, reason: "node_unconfirmed", message: "This seller has not yet reached a Concordium node; no payment is taken. Try again in a minute." };
    // The same signed Concordium payment sent in parallel: only one may be verified and run the handler until its settlement ends
    const key = isEvmNetwork(requirements.network) ? undefined : paymentKeyOf(paymentPayload.payload);
    if (key && !paymentsInFlight.take(key)) return { abort: true, reason: "payment_in_flight", message: "this signed payment is already being processed" };
    const refused = await beforeVerifyChecks(paymentPayload, requirements, transportContext);
    if (refused && key) paymentsInFlight.release(key);
    return refused;
  })
  .onVerifyFailure(async ({ paymentPayload, requirements }) => {
    const key = isEvmNetwork(requirements.network) ? undefined : paymentKeyOf(paymentPayload.payload);
    if (key) paymentsInFlight.release(key);
  });

async function beforeVerifyChecks(paymentPayload: { payload: unknown }, requirements: Parameters<typeof payerAccount>[1], transportContext: unknown): Promise<{ abort: true; reason: string; message?: string } | undefined> {
    const who = await payerAccount(paymentPayload, requirements);
    if (!who.ok) {
      console.log(`refused payment on ${requirements.network}: ${who.reason}`);
      return { abort: true as const, reason: who.code, message: who.reason };
    }
    const sender = who.account;
    // Trust in both directions: if the buyer names its agent in a header, the seller confirms from a node that it is Active and that the paying account is its on-chain agentWallet
    const req = (transportContext as { request?: { adapter?: { req?: express.Request } } } | undefined)?.request?.adapter?.req;
    const buyerAgent = await checkBuyerAgent(req?.header(BUYER_AGENT_HEADER), sender, BUYER_AGENT_POLICY, (id) => readAgent(id));
    if (!buyerAgent.ok) {
      console.log(`refused buyer agent from ${sender}: ${buyerAgent.reason}`);
      // The reason code goes in reason: x402 returns only reason to the buyer (message is dropped)
      return { abort: true as const, reason: `buyer_agent_check_failed:${buyerAgent.code}`, message: buyerAgent.reason };
    }
    if (buyerAgent.named && req?.res) req.res.locals.buyerAgent = buyerAgent;
    if (req?.res && "evm" in who) req.res.locals.evmPayer = { address: who.evm, account: who.account };
    if (!REQUIRE_ELIGIBILITY) return;
    // Every payment re-checks the proof (not just whether the database has a record); if the node is unreachable, refuse rather than fall back to the database
    try {
      if (!sender) throw new Error("no payer");
      const rec = await eligibility.recheck(sender);
      if (req?.res) req.res.locals.buyerEligibility = rec;
    } catch (e) {
      console.log(`refused buyer ${sender}: ${e instanceof Error ? e.message : e}`);
      return {
        abort: true as const,
        reason: "buyer_proof_required",
        message: `Account ${sender} has no current eligibility proof that passes the check at payment time. Verify at ${PUBLIC_URL}/verify?account=${sender}`,
      };
    }
}

resourceServer
  // When the facilitator reports a settlement failure: log the reason; if it returned a transaction hash, read it from the chain ourselves and deliver if the money really arrived
  .onSettleFailure(async ({ error, paymentPayload, requirements }) => {
    const e = error as Error & { errorReason?: string; errorMessage?: string; transaction?: string };
    const evm = isEvmNetwork(requirements.network);
    const held = evm ? undefined : paymentKeyOf(paymentPayload.payload);
    if (held) paymentsInFlight.release(held);
    const payer = evm ? (paymentPayload.payload as { authorization?: { from?: string } }).authorization?.from : payerOf(paymentPayload.payload);
    console.warn(`settlement reported failure: ${e.errorReason ?? e.message}${e.errorMessage && e.errorMessage !== e.errorReason ? ` (${e.errorMessage})` : ""} tx=${e.transaction || "-"} payer=${payer ?? "-"}`);
    // The hash from the error's field or, failing that, its message ("transaction <hash> not found")
    const tx = e.transaction && /^(0x)?[0-9a-f]{64}$/i.test(e.transaction) ? e.transaction : `${e.errorReason ?? ""} ${e.errorMessage ?? ""} ${e.message ?? ""}`.match(/\b(0x)?[0-9a-f]{64}\b/i)?.[0];
    if (tx) e.transaction = tx;
    if (!e.transaction || !payer) return;
    // Base USDC: read the receipt (onBeforeVerify already mapped this payment to a bound Concordium account; here we only confirm the money arrived)
    const paid = evm
      ? await paidOnEvm(e.transaction, { from: payer, payTo: requirements.payTo, amount: requirements.amount, asset: requirements.asset })
      : await paidOnChain(e.transaction, payer, requirements.payTo, requirements.amount, requirements.asset);
    if (!paid.ok) {
      console.warn(`not recovered: ${paid.why}`);
      return;
    }
    // The same signed payment sent many times at once: only one request may be delivered against this transaction
    let first: boolean;
    // Recovery acts on a report of failure: without the ledger it cannot tell a first delivery from a repeat, so it does not recover (outside review)
    try { first = await ledger.claim(e.transaction); } catch (err) { console.error(`not recovered: payment ledger unavailable for ${e.transaction}: ${err instanceof Error ? err.message : err}`); return; }
    if (!first) {
      console.warn(`not recovered: ${e.transaction} was already delivered against`);
      return;
    }
    console.log(`recovered: ${e.transaction} is finalized and pays ${requirements.amount} to ${requirements.payTo}`);
    // Hosted facilitators often report failure for a payment that finalized: record the re-check on this path too
    if (REQUIRE_ELIGIBILITY && !evm) recordRecheck(e.transaction, payer);
    return { recovered: true as const, result: { success: true, transaction: e.transaction, network: requirements.network, payer } };
  })
  // A successful settlement whose transaction was already delivered against (by a recovery above) is not delivered again
  .onAfterSettle(async ({ result, requirements, paymentPayload }) => {
    const held = isEvmNetwork(requirements.network) ? undefined : paymentKeyOf(paymentPayload.payload);
    if (held) paymentsInFlight.release(held);
    if (!result.transaction) {
      // A Concordium settlement with no transaction cannot be recorded, so it cannot be delivered once only
      if (!isEvmNetwork(requirements.network)) throw new AfterSettleAbortError("no_transaction", "the settlement named no transaction");
      return;
    }
    let first: boolean;
    try { first = await ledger.claim(result.transaction); } catch (err) {
      // The money has moved: a buyer who paid gets the call even if the ledger is down (the ledger only stops duplicates)
      console.error(`payment ledger unavailable, delivering ${result.transaction}: ${err instanceof Error ? err.message : err}`);
      return;
    }
    if (!first) throw new AfterSettleAbortError("already_delivered", "this payment was already delivered");
    // The buyer's proof was re-checked before settlement: record that on-chain for this payment, without delaying delivery
    const payer = result.payer || payerOf(paymentPayload.payload);
    if (REQUIRE_ELIGIBILITY && payer && !isEvmNetwork(requirements.network)) recordRecheck(result.transaction, payer);
  })
  // Read again before settling: if the agent was revoked or its wallet changed between verify and settle (the handler anchors in between), do not take the money
  .onBeforeSettle(async ({ paymentPayload, requirements, transportContext }) => {
    const req = (transportContext as { request?: { adapter?: { req?: express.Request } } } | undefined)?.request?.adapter?.req;
    // EVM: re-read CIS-8 before settling; if the binding was revoked in between, do not take the money
    let account = payerOf(paymentPayload.payload);
    if (isEvmNetwork(requirements.network)) {
      const who = await payerAccount(paymentPayload, requirements);
      const before = req?.res?.locals.evmPayer as { account: string } | undefined;
      if (!who.ok || !before || who.account !== before.account) {
        console.log(`refused at settlement, EVM payer: ${who.ok ? "binding changed" : who.reason}`);
        return { abort: true, reason: who.ok ? "evm_payer_not_bound" : who.code };
      }
      account = who.account;
    }
    // The buyer's proof again, just before the money moves: a credential revoked or moved after verification is refused here
    if (REQUIRE_ELIGIBILITY) {
      try {
        if (!account) throw new Error("no payer");
        await eligibility.recheck(account);
      } catch (err) {
        console.log(`refused at settlement, buyer ${account}: ${err instanceof Error ? err.message : err}`);
        return { abort: true, reason: "buyer_proof_required" };
      }
    }
    const named = req?.res?.locals.buyerAgent as Extract<BuyerAgentResult, { named: true }> | undefined;
    if (!named) return;
    const again = await checkBuyerAgent(named.tokenId, account, BUYER_AGENT_POLICY, (id) => readAgent(id));
    if (!again.ok || !again.named || again.wallet !== named.wallet) {
      console.log(`refused at settlement, buyer agent #${named.tokenId}: ${again.ok ? "wallet changed" : again.reason}`);
      return { abort: true, reason: `buyer_agent_check_failed:${again.ok ? "wallet_changed" : again.code}` };
    }
  });

const app = express();
app.disable("x-powered-by");
// Behind a reverse proxy (Hugging Face / Render): take the real IP from X-Forwarded-For and HTTPS from X-Forwarded-Proto
// TRUST_PROXY is read literally: "0" turns it off; the image sets 1, right for Render and Hugging Face (one proxy in front)
const trustProxy = trustProxySetting(process.env.TRUST_PROXY);
if (trustProxy !== undefined) app.set("trust proxy", trustProxy);
// Site-wide limit (per IP per minute); individual routes have stricter limits (e.g. /eligibility/challenge, which spends CCD)
// The gateway's own MCP/A2A tools call its routes over localhost: those calls are limited where they enter (/mcp, /a2a), not here
app.use(baselineLimit({ windowMs: 60_000, limit: Number(env("REQUESTS_PER_MIN", "300")), standardHeaders: "draft-8", legacyHeaders: false, skip: (req) => isSelfCall(req) }));
// sendFile sets Cache-Control: public, max-age=0 by default, which would override the no-store security header
const NO_CACHE_FILE = { cacheControl: false, lastModified: false } as const;
const pages = [new URL("../public/index.html", import.meta.url).pathname, new URL("../public/verify.html", import.meta.url).pathname];
app.use(securityHeaders(inlineScriptHashes(pages), ["/verify"], inlineScriptHashes(pages, "style")));
app.use(express.json({ limit: "256kb" }));

// Rate limits: each challenge spends CCD on-chain, so it is the strictest; the site-wide cap cannot be bypassed by switching IPs
const MIN = 60_000;
// Per-visitor key: IPv6 by /64; the process calling itself is not a visitor
const ip = (req: express.Request) => (isSelfCall(req) ? undefined : clientKey(req.ip));
const validAccount = (req: express.Request) => {
  const a = String(req.body?.account ?? "");
  // A real address (checksum included), so made-up strings cannot use up the per-account or site-wide quota
  if (!/^[1-9A-HJ-NP-Za-km-z]{50}$/.test(a)) return null;
  try { AccountAddress.fromBase58(a); return a; } catch { return null; }
};
const limitChallenge = rateLimit([
  { limiter: new RateLimiter(5, 10 * MIN), key: ip, what: "per IP" },
  // Requests with a malformed account never reach the chain: they do not use up that account's or the site-wide quota (the per-IP limit still counts)
  { limiter: new RateLimiter(3, 60 * MIN), key: (req) => validAccount(req) ?? undefined, what: "per account" },
  { limiter: new RateLimiter(Number(env("CHALLENGES_PER_HOUR", "60")), 60 * MIN), key: (req) => (validAccount(req) ? "all" : undefined), what: "site-wide hourly budget" },
]);
const limitVerify = rateLimit([{ limiter: new RateLimiter(10, 10 * MIN), key: ip, what: "per IP" }]);
const limitRead = rateLimit([{ limiter: new RateLimiter(120, MIN), key: ip, what: "per IP" }]);

// Tell buyer agents before they pay that they must prove eligibility first (format follows the buyerProof proposal in x402 issue #4182)
const PAYMENT_TIMEOUT_S = Number(process.env.PAYMENT_TIMEOUT_S ?? 240);
const buyerExtra = {
  buyerProof: ["adult", "region"],
  buyerProofPolicy: eligibility.describe(),
  buyerProofUrl: `${PUBLIC_URL}/verify`,
  // A buyer agent can name its CIS-8004 token id in this header; the seller checks from a node that the paying account is its agentWallet
  buyerAgentHeader: "X-Concordium-Agent",
  buyerAgentPolicy: BUYER_AGENT_POLICY,
};

app.use(
  paymentMiddleware(
    {
      "GET /signal/:asset": {
        accepts: [
          { asset: "CCD", amount: PRICE_MICROCCD },
          ...PLT_PRICES,
        ].map((p) => ({
          scheme: "exact",
          network: NETWORK,
          payTo: PAY_TO,
          // The buyer sets the transaction expiry from its own clock (now + maxTimeoutSeconds) and the facilitator accepts at most 300 s ahead,
          // so 240 leaves a minute for buyers whose clock runs fast (a real buyer hit this with a 2-minute skew at 300)
          maxTimeoutSeconds: PAYMENT_TIMEOUT_S,
          price: { amount: p.amount, asset: p.asset, extra: buyerExtra },
        })).concat(
          // USDC on Base Sepolia: payTo is the EVM address bound in CIS-8 under this agent's owner; the cis8 field tells the buyer where to check
          EVM
            ? [{
                scheme: "exact",
                network: EVM.network,
                payTo: EVM.payTo,
                maxTimeoutSeconds: PAYMENT_TIMEOUT_S,
                price: EVM.price as unknown as { amount: string; asset: string; extra: typeof buyerExtra },
                extra: {
                  ...buyerExtra,
                  cis8: { registry: `${CIS8_REGISTRY.index}.${CIS8_REGISTRY.subindex}`, concordiumNetwork: NETWORK, namespace: EVM.network, keyType: EVM_KEY_TYPE, publicKey: EVM.publicKey },
                  buyerEvmBinding: "the paying EVM key must be bound to an eligible Concordium account in the CIS-8 registry",
                },
              } as never]
            : [],
        ),
        description: "VeriFlow risk-regime signal (RISK_ON / RISK_OFF), committed on-chain",
        mimeType: "application/json",
        // Names the agent being paid (CIS-8004 registry and token id). No wallet here: the buyer reads agentWallet from the chain and compares it with payTo
        extensions: {
          [AGENT_EXTENSION]: {
            info: { network: NETWORK, registry: `${AGENT_REGISTRY.index}.${AGENT_REGISTRY.subindex}`, badge: AGENT_BADGE, tokenId: AGENT_TOKEN_ID },
            schema: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              additionalProperties: false,
              required: ["network", "registry", "badge", "tokenId"],
              properties: {
                network: { type: "string", pattern: "^ccd:[0-9a-f]{32}$" },
                registry: { type: "string", pattern: "^[0-9]+\\.[0-9]+$" },
                badge: { type: "string", pattern: "^[1-9A-HJ-NP-Za-km-z]{10,40}$" },
                tokenId: { type: "string", pattern: "^[0-9]+$" },
              },
            },
          },
        },
      },
    },
    resourceServer,
  ),
);

async function forward(path: string, res: express.Response, paid: boolean) {
  try {
    const r = await fetch(`${API_URL}${path}`, {
      headers: paid ? { "X-VeriFlow-Gateway": GATEWAY_SECRET } : {},
    });
    res.status(r.status).type("application/json").send(await r.text());
  } catch (e) {
    console.error(`API ${path}:`, e);
    res.status(502).json({ error: "api_unreachable" });
  }
}

// Payment succeeded → fetch the signal from the Python API → anchor the commitment hash → tell the API the transaction hash → return it to the buyer
const anchorer = createAnchorer(env("ANCHOR_KEY_FILE", env("FACILITATOR_KEY_FILE")));
// Requests arriving together for the same not-yet-anchored signal share one anchor transaction
const anchorOnce = singleFlight<string>();

app.get("/signal/:asset", async (req, res) => {
  try {
    const r = await fetch(`${API_URL}/signal/${encodeURIComponent(req.params.asset)}`, {
      headers: { "X-VeriFlow-Gateway": GATEWAY_SECRET },
    });
    const body = await r.json();
    if (!r.ok) return res.status(r.status).json(body);

    // Today's official signal is already on-chain (daily job or an earlier buyer): sell that same one, do not anchor again
    if (!body.anchor_tx) {
      try {
        const tx = await anchorOnce(String(body.commitment), async () => {
          const t = await anchorer.anchor(body.commitment, String(body.signal?.asset ?? req.params.asset).toUpperCase());
          await fetch(`${API_URL}/commitments/${body.commitment}/anchor`, {
            method: "POST",
            headers: { "X-VeriFlow-Gateway": GATEWAY_SECRET, "Content-Type": "application/json" },
            body: JSON.stringify({ anchor_tx: t }),
          });
          return t;
        });
        body.anchor_tx = tx;
        console.log(`anchored ${body.commitment.slice(0, 12)}… → ${tx}`);
      } catch (e) {
        // A signal that is not on-chain cannot be shown to predate the outcome: return an error; x402 settles only on success, so the buyer is not charged
        console.error("anchor failed:", e);
        return res.status(503).json({ error: "anchor_failed", detail: "The signal could not be committed on-chain, so it was not sold and you were not charged. Try again shortly." });
      }
    }
    const ba = res.locals.buyerAgent as Extract<BuyerAgentResult, { named: true }> | undefined;
    if (ba) body.buyer_agent = { token_id: ba.tokenId, registry: `<${AGENT_REGISTRY.index},${AGENT_REGISTRY.subindex}>`, owner: ba.owner, agent_wallet: ba.wallet, checked: "read from a Concordium node before verification and again before settlement: Active, and the payer is its agentWallet" };
    // The buyer's zero-knowledge proof, re-checked for this payment: the record any buyer can show a third party
    const el = res.locals.buyerEligibility as { account: string; requestAnchorTx: string; auditAnchorTx: string; verifiedAt: string; expiresAt: string } | undefined;
    if (el) body.buyer_eligibility = {
      account: el.account,
      policy: eligibility.describe(),
      verification_request_tx: `${NET.explorer}/transaction/${el.requestAnchorTx}`,
      audit_record_tx: `${NET.explorer}/transaction/${el.auditAnchorTx}`,
      proven_at: el.verifiedAt,
      valid_until: el.expiresAt,
      checked: "the stored proof re-checked for this payment, before verification and again before settlement: against the current policy and the identity provider list read from a node, the SDK's official check, both anchors sent by VeriFlow's account, and the credential still owned by the payer",
    };
    const ep = res.locals.evmPayer as { address: string; account: string } | undefined;
    if (ep) body.evm_payer = { address: ep.address, concordium_account: ep.account, cis8_registry: `<${CIS8_REGISTRY.index},${CIS8_REGISTRY.subindex}>`, checked: "payer key recovered from the EIP-3009 signature, bound in CIS-8 (read from a Concordium node) before verification and again before settlement" };
    res.json(body);
  } catch (e) {
    console.error("signal:", e);
    res.status(502).json({ error: "api_unreachable" });
  }
});
app.get("/track-record", (_req, res) => forward("/track-record", res, false));
app.get("/commitments", (_req, res) => forward("/commitments", res, false));
app.get("/commitments/:c", (req, res) => forward(`/commitments/${encodeURIComponent(req.params.c)}`, res, false));

// Public: read an anchored commitment back from Concordium (for the dashboard's one-click verify)
app.get("/onchain/:tx", limitRead, async (req, res) => {
  if (!/^[0-9a-f]{64}$/.test(String(req.params.tx))) return res.status(400).json({ error: "malformed tx hash" });
  try {
    res.json(await anchorer.read(String(req.params.tx)));
  } catch (e) {
    console.error("onchain read:", e);
    res.status(502).json({ error: "node_unreachable" });
  }
});
// Operator account balance: daily commits, automatic reveals and sponsored buyer fees are paid from it; if it runs dry the record stops
// Checked every 10 minutes in the background (/health only returns the cached value, so health checks stay fast); low=true below MIN_OPERATOR_CCD
const MIN_OPERATOR_CCD = Number(env("MIN_OPERATOR_CCD", "100"));
const operator: { account: string; balance_ccd: number | null; checked_at: string | null; low: boolean } = {
  account: "",
  balance_ccd: null,
  checked_at: null,
  low: false,
};
async function refreshOperatorBalance() {
  try {
    const ccd = Number(await anchorer.balanceMicroCcd()) / 1e6;
    Object.assign(operator, { balance_ccd: ccd, checked_at: new Date().toISOString(), low: ccd < MIN_OPERATOR_CCD });
    if (operator.low) console.warn(`operator ${operator.account} balance ${ccd} CCD is below ${MIN_OPERATOR_CCD} CCD — top up from the testnet faucet`);
  } catch (e) {
    console.warn(`operator balance check failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Per-payment re-check records: payment tx -> the registerData transaction that records it (also decodable from the chain alone)
const recheckAnchors = new Map<string, { tx: string; data: string; at: string }>();
const RECHECK_PER_DAY = Number(env("RECHECK_RECORDS_PER_DAY", "15"));
const RECHECK_MIN_CCD = Number(env("RECHECK_MIN_OPERATOR_CCD", "150"));
const recheckDay = { day: "", n: 0 };
function recordRecheck(rawTx: string, payer: string) {
  const paymentTx = rawTx.replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(paymentTx) || recheckAnchors.has(paymentTx)) return;
  // Each record costs the anchoring account a fee (about 5 testnet CCD): never let it eat what the daily commits and reveals need
  const day = new Date().toISOString().slice(0, 10);
  if (recheckDay.day !== day) Object.assign(recheckDay, { day, n: 0 });
  if (recheckDay.n >= RECHECK_PER_DAY) return console.warn(`re-check record for ${paymentTx} skipped: ${RECHECK_PER_DAY} already today`);
  if (operator.balance_ccd !== null && operator.balance_ccd < RECHECK_MIN_CCD) return console.warn(`re-check record for ${paymentTx} skipped: operator balance ${operator.balance_ccd} CCD < ${RECHECK_MIN_CCD}`);
  recheckDay.n++;
  eligibility.anchorRecheck(paymentTx, payer).then((r) => {
    if (!r) return console.warn(`re-check record for ${paymentTx}: ${payer} has no eligibility record`);
    console.log(`re-check record for ${paymentTx}: ${r.tx}`);
    if (recheckAnchors.size >= 5000) recheckAnchors.delete(recheckAnchors.keys().next().value as string);
    recheckAnchors.set(paymentTx, { ...r, at: new Date().toISOString() });
  }).catch((e) => console.error(`re-check record for ${paymentTx} not anchored: ${e instanceof Error ? e.message : e}`));
}
app.get("/eligibility/recheck/:tx", limitRead, (req, res) => {
  const tx = String(req.params.tx);
  if (!/^[0-9a-f]{64}$/.test(tx)) return res.status(400).json({ error: "bad_tx" });
  const r = recheckAnchors.get(tx);
  if (!r) return res.status(404).json({ error: "not_recorded", message: "No re-check record for this payment on this server (yet, or since its last restart; the chain keeps it either way)." });
  res.json({ payment_tx: tx, recheck_record_tx: r.tx, recheck_record_url: `${NET.explorer}/transaction/${r.tx}`, data: r.data, recorded_at: r.at });
});

// Which commit is live, so anyone can match the site to the code (Render sets RENDER_GIT_COMMIT)
const DEPLOYED_COMMIT = (process.env.RENDER_GIT_COMMIT ?? process.env.GIT_COMMIT ?? "").slice(0, 7) || null;
app.get("/health", limitRead, async (_req, res) => {
  try {
    const r = await fetch(`${API_URL}/health`);
    const api = (await r.json()) as Record<string, unknown>;
    res.status(r.status).json({ ...api, operator, commit: DEPLOYED_COMMIT });
  } catch (e) {
    console.error("health:", e);
    res.status(502).json({ ok: false, error: "api_unreachable", operator, commit: DEPLOYED_COMMIT });
  }
});

// ── Buyer eligibility (Verify & Access) ─────────────────────
const verifyPage = new URL("../public/verify.html", import.meta.url);
app.get("/verify", limitRead, (_req, res) => res.sendFile(verifyPage.pathname, NO_CACHE_FILE));

// Public dashboard (the browser recomputes hashes itself, no need to trust this server) and the Agent Card
const dashboardPage = new URL("../public/index.html", import.meta.url);
app.get("/", limitRead, (_req, res) => res.sendFile(dashboardPage.pathname, NO_CACHE_FILE));
const agentCard = new URL("../../agent-card.json", import.meta.url);
app.get("/.well-known/agent-card.json", limitRead, (_req, res) => res.type("application/json").sendFile(agentCard.pathname, NO_CACHE_FILE));
// The demo buyer agent's Agent Card (its SHA-256 is pinned in CIS-8004, so the content must not change)
const buyerCard = new URL("../../agents/buyer-agent-card.json", import.meta.url);
app.get("/agents/buyer-agent-card.json", limitRead, (_req, res) => res.type("application/json").sendFile(buyerCard.pathname, NO_CACHE_FILE));

// "Check another team's seller": the guard on a fixed list of x402 sellers, no payment (guard-presets.ts)
const limitGuard = rateLimit([{ limiter: new RateLimiter(20, MIN), key: ip, what: "per IP" }]);
app.use("/guard", limitGuard);
// One seller on Concordium mainnet, checked live by the published npm package (read-only: no wallet, nothing paid). Its Base payout
// is checked against the key bound to its owner in CIS-8 on mainnet
const mainnetGuard = (() => {
  let deps: ReturnType<typeof pkgGuardDeps> | undefined;
  return (url: string, init: RequestInit) => pkgCheckSellerAt(url, init, (deps ??= pkgGuardDeps({ network: "mainnet" })), {}, PKG_NETWORKS.mainnet.evmNetwork);
})();
app.use(guardPresetRouter({ publicUrl: PUBLIC_URL, deps: guardDeps, mainnet: process.env.MAINNET_GUARD_PRESET === "off" ? undefined : mainnetGuard }));

// Live demo button: our buyer agent #1478 buys one call from this seller, on the server (demo-buy.ts). Off unless a key file is configured
const DEMO_KEY = process.env.DEMO_BUYER_KEY_FILE?.trim();
const demoLock = { busy: false };
const demoCounter = process.env.DATABASE_URL ? postgresCounter(process.env.DATABASE_URL) : undefined;
app.use(
  DEMO_KEY
    ? demoBuyRouter({
        makeAgent: async () => (await import("./agent.js")).createBuyerAgent({ keyFile: DEMO_KEY, gateway: PUBLIC_URL, agentTokenId: env("DEMO_BUYER_AGENT", "1478"), ccdOnly: true, requireSeller: true }),
        counter: demoCounter,
        dailyLimit: Number(env("DEMO_DAILY_LIMIT", "20")),
        perIpPerHour: Number(env("DEMO_PER_IP_PER_HOUR", "3")),
        ipOf: (q) => clientKey(q.ip),
        lock: demoLock,
        recheckOf: (tx) => recheckAnchors.get(tx) ?? null,
      })
    : demoDisabledRouter(),
);
// Second demo button: the same buyer pays #1313 through the escrow contract, which checks CIS-8004 itself (demo-escrow.ts)
const ESCROW_CONTRACT = process.env.ESCROW_CONTRACT?.trim();
app.use(
  DEMO_KEY && ESCROW_CONTRACT && /^\d+$/.test(ESCROW_CONTRACT)
    ? escrowDemoRouter({
        makeChain: () => escrowChain(DEMO_KEY, BigInt(ESCROW_CONTRACT)),
        expectedModule: process.env.EXPECTED_ESCROW_MODULE ?? ESCROW_MODULE,
        lock: demoLock,
        counter: demoCounter,
        dailyLimit: Number(env("ESCROW_DEMO_DAILY_LIMIT", "10")),
        perIpPerHour: Number(env("ESCROW_DEMO_PER_IP_PER_HOUR", "2")),
        ipOf: (q) => clientKey(q.ip),
      })
    : escrowDemoDisabledRouter(),
);

app.post("/eligibility/challenge", limitChallenge, async (req, res) => {
  try {
    const r = await eligibility.challenge(String(req.body?.account ?? ""));
    console.log(`verification request anchored (VRA) ${r.requestAnchorTx}`);
    res.json(r);
  } catch (e) {
    console.error("challenge failed:", e);
    res.status(400).json({ error: publicMessage(e) });
  }
});

app.post("/eligibility/verify", limitVerify, async (req, res) => {
  const { id, presentation } = req.body ?? {};
  try {
    const json = typeof presentation === "string" ? presentation : JSON.stringify(presentation);
    const rec = await eligibility.verify(String(id), json);
    console.log(`eligible: ${rec.account} (idp ${rec.issuer})  VRA ${rec.requestAnchorTx}  VAA ${rec.auditAnchorTx}`);
    const { presentationJson: _p, requestJson: _r, credId: _c, challengeId: _i, ...out } = rec;
    res.json({ eligible: true, ...out });
  } catch (e) {
    console.log("eligibility refused:", e instanceof Error ? e.message : e);
    res.status(403).json({ eligible: false, error: publicMessage(e) });
  }
});

app.get("/eligibility/:account", (req, res) => {
  const rec = eligibility.status(req.params.account);
  // Public endpoints do not return the credential id (it is on-chain anyway, but there is no need to help link accounts to identity credentials)
  const { credId: _c, presentationJson: _p, requestJson: _r, challengeId: _i, ...pub } = rec ?? ({} as Record<string, unknown>);
  // policy goes last: rec also has a policy field (the fingerprint string), which must not overwrite the full policy description
  res.json({ eligible: !!rec, ...pub, policyId: rec?.policy, policy: eligibility.describe() });
});

// Public MCP (Streamable HTTP): free tools + buying instructions, never touches anyone's keys
const SELF_URL = `http://127.0.0.1:${env("GATEWAY_PORT", "4020")}`;
// Each MCP/A2A call can make several reads of this gateway and a node: limit them where they come in, per visitor
const limitAgentApi = rateLimit([{ limiter: new RateLimiter(Number(env("AGENT_API_PER_MIN", "60")), MIN), key: ip, what: "per IP" }]);
app.use(["/mcp", "/a2a"], limitAgentApi);
mountRemoteMcp(app, { selfUrl: SELF_URL, publicUrl: PUBLIC_URL });
// A2A (the Agent Card's url points here): read-only skills as well
mountA2A(app, { selfUrl: SELF_URL, publicUrl: PUBLIC_URL });

// Unknown paths and unexpected errors: answer with our own JSON and keep the security headers set above
// (Express's default error page sets its own CSP; ZAP flags it for missing frame-ancestors and similar rules)
app.use((_req, res) => res.status(404).json({ error: "not_found" }));
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("unhandled:", err);
  if (!res.headersSent) res.status(500).json({ error: "internal_error" });
});

const PORT = Number(env("GATEWAY_PORT", "4020"));
// Daily public signals: the record grows every day (DAILY_SIGNALS=off disables it; off by default for local development)
// DAILY_SIGNALS=reveal: since v2, v1 issues no new signals (v2 calls come from the daily-v2 GitHub workflow); it only keeps revealing v1 commitments that are due
const DAILY_MODE = env("DAILY_SIGNALS", "off");
const DAILY = DAILY_MODE !== "off";
if (DAILY) {
  startDailySignals(
    {
      apiUrl: API_URL,
      secret: GATEWAY_SECRET,
      assets: DAILY_MODE === "reveal" ? [] : env("DAILY_ASSETS", "BTC,ETH").split(",").map((a) => a.trim().toUpperCase()).filter(Boolean),
      anchor: (c, asset) => anchorer.anchor(c, asset),
      log: (m) => console.log(m),
    },
    Number(env("DAILY_INTERVAL_MIN", "30")) * 60_000,
    60_000,
    // Automatic reveal: contract mode only (the contract recomputes the hash itself)
    anchorer.contract && {
      apiUrl: API_URL,
      record: anchorer.contract.record,
      reveal: anchorer.contract.reveal,
      log: (m) => console.log(m),
    },
  );
}

operator.account = anchorer.address;
setTimeout(refreshOperatorBalance, 5_000);
setInterval(refreshOperatorBalance, 10 * 60_000);

// Backup for the v2 record: GitHub's hourly schedule is often hours late, and one asset-day with no commit blocks the score for
// good. Every 30 minutes this process runs the same idempotent round as daily-v2.yml (reveal what is due, commit yesterday's
// calls), with the same committer key, only if that key is the contract's committer. V2_BACKUP_JOB=off turns it off
async function v2BackupRound() {
  if (process.env.V2_BACKUP_JOB === "off" || !process.env.DATABASE_URL) return;
  try {
    const { dailyV2Once } = await import("./daily-v2.js");
    const { createV2Reader, v2Address, TESTNET_REGISTRY_V2_INDEX } = await import("./contract-v2.js");
    const { ContractAddress } = await import("@concordium/web-sdk");
    const address = v2Address() ?? (NET.name === "testnet" ? ContractAddress.create(TESTNET_REGISTRY_V2_INDEX, 0n) : undefined);
    if (!address) return;
    const keyFile = process.env.V2_COMMITTER_KEY_FILE ?? env("ANCHOR_KEY_FILE", env("FACILITATOR_KEY_FILE"));
    const committer = (await createV2Reader(address).summary()).committer;
    if (!committer || committer !== anchorer.address) return; // not our committer key: leave it to the scheduled job
    const out = await dailyV2Once({ address, url: process.env.DATABASE_URL, keyFile, log: (m) => console.log(`v2 backup: ${m}`) });
    if (out.reveals.length || out.commits.length || out.errors.length) console.log(`v2 backup round: ${JSON.stringify({ reveals: out.reveals, commits: out.commits, errors: out.errors })}`);
  } catch (e) {
    console.warn(`v2 backup round failed: ${e instanceof Error ? e.message : e}`);
  }
}
setTimeout(v2BackupRound, 2 * 60_000).unref();
setInterval(v2BackupRound, 30 * 60_000).unref();

// Some SDK checks are not awaited internally (e.g. createChecked's context check): one bad proof must not take the whole server down
process.on("unhandledRejection", (e) => console.warn(`unhandled rejection (ignored): ${e instanceof Error ? e.message : e}`));

// The node must belong to the chain CONCORDIUM_NETWORK selects: check before accepting connections, then every minute.
// If the node is unreachable, the site starts but takes no payment until a check succeeds (fail closed); if it is the wrong chain, stop.
const checkNetwork = (): Promise<boolean> =>
    createGrpc()
      .getConsensusStatus()
      .then((c) => checkGenesis(BlockHash.toHexString(c.genesisBlock)))
      .then(() => {
        if (!networkConfirmed) console.log(`network: ${NET.name} (${NET.caip2})`);
        networkConfirmed = true;
        return true;
      })
      .catch((e) => {
        if (/is not (testnet|mainnet)/.test(String(e))) {
          console.error(`❌ ${e instanceof Error ? e.message : e}`);
          process.exit(1);
        }
        console.warn(`network check skipped: ${e instanceof Error ? e.message : e}`);
        return false;
      });
// Before accepting connections, try up to 3 times (20 s gRPC timeout each) to get the node's genesis; stop on the wrong chain.
// If all 3 fail, start without taking payments, and check again every minute.
for (let i = 0; i < 3 && !(await Promise.race([checkNetwork(), new Promise<boolean>((r) => setTimeout(() => r(false), 25_000))])); i++);
setInterval(checkNetwork, 60_000).unref();

app.listen(PORT, () => {
  console.log(`gateway on http://localhost:${PORT}  payTo=${PAY_TO}  price=${PRICE_MICROCCD} microCCD${PLT_PRICES.map((p) => ` or ${p.amount} ${p.asset} units`).join("")}  anchor=${anchorer.address} via ${anchorer.mode}`);
  console.log(`daily public signals: ${DAILY_MODE === "reveal" ? "v1 reveals only (v2 signals come from the daily-v2 workflow)" : DAILY ? "on" : "off"}`);
  console.log(`buyer eligibility ${REQUIRE_ELIGIBILITY ? "REQUIRED" : "off"}: age ≥ ${MIN_AGE}, not resident in ${eligibility.policy.restrictedCountries.join(",")}  → ${PUBLIC_URL}/verify`);
  if (EVM) {
    console.log(`also accepts ${EVM.price} USDC on ${EVM.network} → ${EVM.payTo} via ${EVM.facilitator}`);
    // Self-check: is the payout key bound in CIS-8 under this agent's owner? If not, buyers will refuse to pay (logged only; startup is not blocked)
    readAgent(AGENT_TOKEN_ID)
      .then((a) => checkEvmBinding({ address: EVM.payTo, publicKey: EVM.publicKey, namespace: EVM.network, expectOwner: a?.owner ?? "?" }, sameAccount))
      .then((r) => (r.ok ? console.log(`CIS-8: ${EVM.payTo} is bound to agent #${AGENT_TOKEN_ID}'s owner ${r.owner}`) : console.warn(`CIS-8 self-check failed, buyers will refuse EVM payments: ${r.reason}`)))
      .catch((e) => console.warn(`CIS-8 self-check could not run: ${e instanceof Error ? e.message : e}`));
  }
});
