/**
 * A complete x402 seller on Concordium testnet with concordium-x402-seller: one paid route, the buyer's proof re-checked at every
 * payment, buyer agents checked, and the three eligibility endpoints. Type-checked in CI (npm run check:examples).
 *
 * package.json needs "type": "module". Install:
 *   npm install concordium-x402-seller @x402/core @x402/express @x402/concordium @concordium/web-sdk express
 *   npm install -D @types/express
 * Environment:
 *   FACILITATOR_URL, FACILITATOR_API_KEY  a facilitator that supports scheme "exact" on Concordium (Concordium runs one for testnet;
 *                                         ask them for the URL and a key). The default x402.org facilitator does not, and the first
 *                                         request then fails with: Facilitator does not support scheme "exact" on network "ccd:…"
 *   PAY_TO                                your agent's on-chain agentWallet (the account buyers' guards will require)
 *   AGENT_TOKEN_ID, AGENT_BADGE           your CIS-8004 token id and its badge (the full token address string, not shortened)
 *   ANCHOR_KEY_FILE                       a Concordium wallet export of the account that pays for the two eligibility anchors
 *                                         (not a buyer's key; keep the file out of your repository)
 */
import { readFileSync } from "node:fs";
import express from "express";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { ExactConcordiumScheme } from "@x402/concordium/exact/server";
import { ConcordiumGRPCNodeClient, credentials } from "@concordium/web-sdk/nodejs";
import {
  EligibilityService,
  EligibilityStore,
  NETWORKS,
  anchorAccountFromExport,
  buyerRequirementsExtra,
  concordiumChain,
  concordiumSeller,
  eligibilityHandlers,
  filePersistence,
  sellerAgentExtension,
} from "concordium-x402-seller";

const net = NETWORKS.testnet;
const env = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`set ${k}`);
  return v;
};

// 1. Who may buy: a zero-knowledge proof of 18+ and residence outside these countries, anchored on-chain, re-checked at payment
const grpc = new ConcordiumGRPCNodeClient(net.grpc.host, net.grpc.port, credentials.createSsl(), { timeout: 20_000 });
const anchor = anchorAccountFromExport(readFileSync(env("ANCHOR_KEY_FILE"), "utf8"));
const store = await new EligibilityStore(filePersistence("data/eligible.json")).init();
const policy = { minAge: 18, restrictedCountries: ["KP", "IR"] };
const eligibility = new EligibilityService(policy, store, concordiumChain({ grpc, anchor, did: net.did }), net.did);

// 2. The x402 resource server, with the Concordium checks attached
const facilitator = new HTTPFacilitatorClient({
  url: env("FACILITATOR_URL"),
  createAuthHeaders: async () => {
    const h = { Authorization: `Bearer ${env("FACILITATOR_API_KEY")}` };
    return { verify: h, settle: h, supported: h };
  },
});
const server = new x402ResourceServer(facilitator).register(net.caip2, new ExactConcordiumScheme());
const verifyUrl = "https://seller.example/verify";
concordiumSeller(server, { network: "testnet", grpc, eligibility, verifyUrl, buyerAgent: "optional" });

// 3. One paid route. The price is { asset: "CCD", amount: micro-CCD }: a plain "1" or 1 would be priced in the scheme's default
//    token (USDR), not CCD. A PLT is { asset: "<token id>", amount: "<smallest unit>" }.
const routes = {
  "GET /report": {
    accepts: {
      scheme: "exact",
      network: net.caip2,
      payTo: env("PAY_TO"),
      maxTimeoutSeconds: 240,
      price: { asset: "CCD", amount: "1000000", extra: buyerRequirementsExtra({ verifyUrl, policy: eligibility.describe(), buyerAgent: "optional" }) },
    },
    description: "One report",
    mimeType: "application/json",
    extensions: sellerAgentExtension({ network: "testnet", tokenId: env("AGENT_TOKEN_ID"), badge: env("AGENT_BADGE") }),
  },
};

const app = express();
app.use(express.json({ limit: "64kb" }));

// 4. The eligibility endpoints a wallet page talks to. Put a rate limit in front of both POSTs: each one pays for an anchor
const http = eligibilityHandlers(eligibility);
app.post("/eligibility/challenge", async (req, res) => {
  const r = await http.challenge(req.body);
  res.status(r.status).json(r.body);
});
app.post("/eligibility/verify", async (req, res) => {
  const r = await http.verify(req.body);
  res.status(r.status).json(r.body);
});
app.get("/eligibility/:account", (req, res) => {
  const r = http.status(req.params.account);
  res.status(r.status).json(r.body);
});

app.use(paymentMiddleware(routes, server));
app.get("/report", (_req, res) => {
  res.json({ report: "…" });
});
app.listen(4000, () => console.log("seller on :4000"));
