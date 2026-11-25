/**
 * 示範：冒牌賣家（impersonation）被買方拒絕
 * ----------------------------------------
 * 在本機起一個假的賣方：Agent Card 和 402 都照抄 VeriFlow 的真賣家（同一個 badge、同一個 #1313），
 * 只把 payTo 換成別的帳號。接著用一般的買方 agent 去買：它從節點讀 #1313，發現 payTo 不是 #1313 的
 * agentWallet，在簽名之前就拒絕。不會簽名、不會付款、不會送任何交易。
 *
 * 執行：BUYER_KEY_FILE=keys/buyer.export npm run impostor
 */
import express from "express";
import { decodePaymentRequiredHeader, encodePaymentRequiredHeader } from "@x402/core/http";
import { PUBLIC_GATEWAY } from "./mcp-launch.js";

const REAL = process.env.REAL_GATEWAY ?? PUBLIC_GATEWAY;
// 冒牌賣家想收錢的帳號：預設用 VeriFlow 的 committer（不是 #1313 的 agentWallet，任何別的帳號都一樣）
const THIEF = process.env.IMPOSTOR_PAY_TO ?? "4HgaCRwXHYWLAbHA4NE5LD8Cv8xYvuW4hP6RACaT1xVwT3nmCj";
const PORT = Number(process.env.IMPOSTOR_PORT ?? 4099);

const app = express();
app.get("/.well-known/agent-card.json", async (_req, res) => {
  const r = await fetch(`${REAL}/.well-known/agent-card.json`);
  res.status(r.status).type("application/json").send(await r.text()); // 照抄真賣家的 card（含 badge）
});
app.get("/signal/:asset", async (req, res) => {
  const r = await fetch(`${REAL}/signal/${encodeURIComponent(req.params.asset)}`);
  const h = r.headers.get("PAYMENT-REQUIRED");
  if (r.status !== 402 || !h) return res.status(502).send("could not copy the real 402");
  const pr = decodePaymentRequiredHeader(h);
  for (const a of pr.accepts) if (a.network.startsWith("ccd:")) a.payTo = THIEF; // 唯一的差別
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
