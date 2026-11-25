/**
 * Self-hosted x402 facilitator (Concordium testnet)
 * -------------------------------------------
 * Job: verify the buyer's signed transfer → co-sign as sponsor and pay the fee → submit → wait for finalization.
 * There was no public Concordium x402 facilitator at first, so we host one (the official package ships the full implementation).
 *
 * Run: npm run facilitator   (default http://localhost:4021)
 *
 * Dropped connections: an idle connection can be silently cut by network equipment (symptom: read ETIMEDOUT).
 *   - /verify on a network error → reconnect and retry once automatically (verify moves no money, so retrying is safe)
 *   - /settle on a network error → reconnect but do not resend (avoids double settlement); report the error so the buyer can retry
 */
import express from "express";
import { rateLimit as baselineLimit } from "express-rate-limit";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactConcordiumScheme } from "@x402/concordium/exact/facilitator";
import { toConcordiumFacilitatorSigner } from "@x402/concordium";
import { NETWORK, env, loadAccount } from "./config.js";
import { grpcEndpoint, isTransient } from "./grpc.js";
import { RateLimiter, rateLimit } from "./security.js";

const sponsor = loadAccount(env("FACILITATOR_KEY_FILE"));

/** Build a fresh facilitator (with a fresh node connection) */
function build() {
  const [host, port] = grpcEndpoint();
  const signer = toConcordiumFacilitatorSigner(sponsor.address, sponsor.signer, { host, port, useTls: true, network: NETWORK });
  return new x402Facilitator().register(NETWORK, new ExactConcordiumScheme({ signer }));
}

let facilitator = build();
function reconnect(why: unknown) {
  console.log(`node connection reset (${why instanceof Error ? why.message : String(why)})`);
  facilitator = build();
}

/** A verify error may be thrown, or wrapped in invalidReason (e.g. signature_verification_failed: read ETIMEDOUT) */
const transientResult = (r: { isValid?: boolean; invalidReason?: string }) => r.isValid === false && isTransient(r.invalidReason ?? "");

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(baselineLimit({ windowMs: 60_000, limit: Number(env("FACILITATOR_CALLS_PER_MIN", "300")), standardHeaders: "draft-8", legacyHeaders: false }));
// Listens on 127.0.0.1 only (called by the gateway itself) but still rate-limited: every verify/settle calls a Concordium node
const limitCalls = rateLimit([{ limiter: new RateLimiter(Number(env("FACILITATOR_CALLS_PER_MIN", "300")), 60_000), key: (req) => req.ip ?? "local", what: "per caller" }]);

app.get("/supported", (_req, res) => {
  res.json(facilitator.getSupported());
});

app.post("/verify", limitCalls, async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body;
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await facilitator.verify(paymentPayload, paymentRequirements);
      if (attempt === 1 && transientResult(r)) {
        reconnect(r.invalidReason);
        continue;
      }
      return res.json(r);
    } catch (e) {
      if (attempt === 1 && isTransient(e)) {
        reconnect(e);
        continue;
      }
      return res.status(500).json({ error: String(e) });
    }
  }
});

app.post("/settle", limitCalls, async (req, res) => {
  try {
    const result = await facilitator.settle(req.body.paymentPayload, req.body.paymentRequirements);
    console.log("settled:", JSON.stringify(result));
    if (!result.success && isTransient(result.errorReason ?? "")) reconnect(result.errorReason);
    res.json(result);
  } catch (e) {
    if (isTransient(e)) reconnect(e);
    res.status(500).json({ error: String(e) });
  }
});

const PORT = Number(env("FACILITATOR_PORT", "4021"));
// When deployed it is local-only (the gateway calls it on the same machine), never exposed
// Local gateway only: listens on 127.0.0.1 by default (/settle does no eligibility check; that happens in the gateway's onBeforeVerify)
const HOST = env("FACILITATOR_HOST", "127.0.0.1");
process.on("unhandledRejection", (e) => console.warn(`unhandled rejection (ignored): ${e instanceof Error ? e.message : e}`));
/** The embedding gateway waits for this: the x402 middleware asks the facilitator which payment kinds it supports at startup */
export const listening = new Promise<void>((resolve) => app.listen(PORT, HOST, () => {
  resolve();
  console.log(`facilitator on http://localhost:${PORT}  sponsor=${sponsor.address}  network=${NETWORK}`);
}));
