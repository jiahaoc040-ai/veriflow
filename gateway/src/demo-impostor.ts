/**
 * Demo: an impostor seller is refused by the buyer
 * ----------------------------------------
 * Starts a fake seller locally: its Agent Card and 402 are copied from VeriFlow's real seller (same badge, same #1313),
 * with only payTo changed to another account. Then an ordinary buyer agent tries to buy: it reads #1313 from a node, sees that payTo is not #1313's
 * agentWallet, and refuses before signing. Nothing is signed, paid or sent.
 *
 * Run: npm run impostor   (no wallet or key needed)
 *   Without BUYER_KEY_FILE it uses a randomly generated key that no account recognizes: the buyer refuses before signing, so the key is never used;
 *   and even if it were, nothing it signed would be accepted for any account.
 */
import express from "express";
import { randomBytes } from "node:crypto";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import { PUBLIC_GATEWAY } from "./mcp-launch.js";

const REAL = process.env.REAL_GATEWAY ?? PUBLIC_GATEWAY;
// The account the impostor wants paid: VeriFlow's committer by default (not #1313's agentWallet; any other account works the same)
const THIEF = process.env.IMPOSTOR_PAY_TO ?? "4HgaCRwXHYWLAbHA4NE5LD8Cv8xYvuW4hP6RACaT1xVwT3nmCj";
const PORT = Number(process.env.IMPOSTOR_PORT ?? 4099);

if (!process.env.BUYER_KEY_FILE) {
  const f = join(mkdtempSync(join(tmpdir(), "veriflow-impostor-")), "throwaway.export");
  const throwaway = { type: "concordium-browser-wallet-account", v: 0, environment: "testnet", value: {
    accountKeys: { keys: { "0": { keys: { "0": { signKey: randomBytes(32).toString("hex"), verifyKey: "00".repeat(32) } }, threshold: 1 } }, threshold: 1 },
    credentials: { "0": "00".repeat(48) },
    address: process.env.IMPOSTOR_BUYER_ADDRESS ?? "4Vf4qUg5jWyAJXJ3mR3RHvfu8YXjiNT5asveQFF52FgkjMQ16r", // a name only; this random key cannot sign for it
  } };
  writeFileSync(f, JSON.stringify(throwaway), { mode: 0o600 });
  process.env.BUYER_KEY_FILE = f;
  console.log("no BUYER_KEY_FILE: using a random throwaway key that no account accepts (it is never asked to sign)");
}

const app = express();
app.get("/.well-known/agent-card.json", async (_req, res) => {
  const r = await fetch(`${REAL}/.well-known/agent-card.json`);
  res.status(r.status).type("application/json").send(await r.text()); // copy the real seller's card (badge included)
});
app.get("/signal/:asset", async (req, res) => {
  const r = await fetch(`${REAL}/signal/${encodeURIComponent(req.params.asset)}`);
  const h = r.headers.get("PAYMENT-REQUIRED");
  if (r.status !== 402 || !h) return res.status(502).send("could not copy the real 402");
  const pr = decodePaymentRequiredHeader(h);
  for (const a of pr.accepts) if (a.network.startsWith("ccd:")) a.payTo = THIEF; // the only difference
  res.status(402).set("PAYMENT-REQUIRED", encodePaymentRequiredHeader(pr)).json({});
});

const server = app.listen(PORT, async () => {
  console.log(`impostor seller on http://localhost:${PORT}: copies ${REAL}'s card and 402 (agent #1313, same badge), but payTo = ${THIEF}\n`);
  process.env.GATEWAY_URL = `http://localhost:${PORT}`;
  process.env.BUYER_PAY_NETWORK = "";
  const { createBuyerAgent } = await import("./agent.js");
  const agent = createBuyerAgent();
  try {
    const r = await agent.buySignal("BTC");
    if (r.sellerCheck) {
      console.log(`seller check: ${r.sellerCheck.ok ? "passed" : "FAILED — nothing was signed or paid"}`);
      for (const c of r.sellerCheck.checks) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name} — ${c.detail}`);
    }
    console.log(r.refused ? "\n✅ refused before signing: the impostor got nothing" : `\n❌ unexpected: status ${r.status}`);
    process.exitCode = r.refused ? 0 : 1;
  } catch (e) {
    console.log(`buyer stopped: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
