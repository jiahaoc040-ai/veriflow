/**
 * A2A（Agent2Agent）端點：POST /a2a，JSON-RPC 2.0，message/send
 * ------------------------------------------------------------
 * Agent Card（/.well-known/agent-card.json）的 url 指向這裡。別的 agent 傳一則訊息，
 * 我們依技能回一則 agent 訊息（文字摘要 + data 部分的完整結果）。只有唯讀技能：
 *   track_record   命中率（每個資產每天只算一次、只算有上鏈的）
 *   commitments    所有鏈上承諾
 *   verify_signal  驗證承諾（訊息裡放 64 字元承諾；data 可附 canonical）
 *   eligibility    查帳號是否通過零知識資格驗證（訊息裡放帳號地址）
 *   how_to_buy     x402 付款條件（付給誰、多少、需要什麼證明）——付款要用買方自己的錢包
 * 選技能：data 部分的 {"skill": "..."} 優先，否則看文字關鍵字。
 */
import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { createChainReader, errText, publicOps, type PublicApi } from "./mcp-tools.js";

export const A2A_SKILLS = ["track_record", "commitments", "verify_signal", "eligibility", "how_to_buy"] as const;
type Skill = (typeof A2A_SKILLS)[number];

type Part = { kind?: string; text?: string; data?: Record<string, unknown> };
type IncomingMessage = { role?: string; parts?: Part[]; messageId?: string; contextId?: string; taskId?: string };

const COMMITMENT = /\b[0-9a-f]{64}\b/;
const ACCOUNT = /\b[1-9A-HJ-NP-Za-km-z]{50}\b/;

/** 從訊息挑技能與參數 */
export function route(msg: IncomingMessage): { skill: Skill | "help"; commitment?: string; canonical?: string; account?: string } {
  const parts = Array.isArray(msg.parts) ? msg.parts : [];
  const text = parts.filter((p) => p?.kind === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
  const data = Object.assign({}, ...parts.filter((p) => p?.kind === "data" && p.data && typeof p.data === "object").map((p) => p.data));
  const pick = (k: string) => (typeof data[k] === "string" ? (data[k] as string) : undefined);
  const commitment = pick("commitment") ?? text.match(COMMITMENT)?.[0];
  const account = pick("account") ?? text.match(ACCOUNT)?.[0];
  const canonical = pick("canonical");
  const asked = pick("skill");
  if (asked && (A2A_SKILLS as readonly string[]).includes(asked)) return { skill: asked as Skill, commitment, canonical, account };
  const t = text.toLowerCase();
  if (commitment && /verif|check|commit|hash/.test(t)) return { skill: "verify_signal", commitment, canonical };
  if (/eligib|verified buyer|zero.knowledge|\bzk\b/.test(t) || (account && !commitment)) return { skill: "eligibility", account };
  if (/track|record|hit.?rate|performance|accura/.test(t)) return { skill: "track_record" };
  if (/commitments|history|anchors|list/.test(t)) return { skill: "commitments" };
  if (/buy|price|pay|cost|purchase|signal|x402/.test(t)) return { skill: "how_to_buy" };
  if (commitment) return { skill: "verify_signal", commitment, canonical };
  return { skill: "help" };
}

const HELP =
  "VeriFlow (Concordium agent #1313) sells RISK_ON / RISK_OFF signals for BTC and ETH over x402; every signal is committed " +
  "on Concordium before its 7-day outcome. Ask for: the track record, the on-chain commitments, verify <64-char commitment>, " +
  "eligibility of <account address>, or how to buy. Or send a data part {\"skill\": \"" + A2A_SKILLS.join("\" | \"") + "\"}.";

export function mountA2A(app: Express, opts: { selfUrl: string; publicUrl: string }) {
  const api: PublicApi = {
    gateway: opts.publicUrl,
    async get(path) {
      const r = await fetch(`${opts.selfUrl}${path}`);
      if (!r.ok) throw new Error(`${path} → HTTP ${r.status}: ${await r.text()}`);
      return r.json();
    },
  };
  const ops = publicOps(api, createChainReader(api, "read by VeriFlow's A2A endpoint (for a check independent of VeriFlow, verify in your own agent)"));

  async function answer(msg: IncomingMessage): Promise<{ text: string; data?: unknown }> {
    const r = route(msg);
    switch (r.skill) {
      case "track_record": {
        const t = (await ops.trackRecord()) as { matured?: number; signal_days?: number; duplicate_asset_days?: number; duplicate_asset_days_by_contract?: { v1?: number; v2?: number }; scoring_rule?: string };
        return {
          text: `Track record: ${t.signal_days ?? 0} asset-days committed, ${t.duplicate_asset_days_by_contract?.v2 ?? t.duplicate_asset_days ?? 0} with more than one commit on contract v2, ${t.matured ?? 0} past the horizon. No hit rate is published; the score comes from the chain-only rule: ${t.scoring_rule ?? "docs/SCORING-v2.md"}.`,
          data: t,
        };
      }
      case "commitments": {
        const c = (await ops.commitments()) as unknown[];
        return { text: `${c.length} signals committed on Concordium; each entry links its anchor transaction.`, data: c };
      }
      case "verify_signal": {
        if (!r.commitment) return { text: "Send the 64-character commitment to verify." };
        const v = await ops.verifySignal(r.commitment, r.canonical);
        if (!v) return { text: "This commitment exists but has not been anchored on-chain yet." };
        return { text: `Verified: ${v.verified}. ${v.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name}`).join("; ")}.`, data: v };
      }
      case "eligibility": {
        if (!r.account) return { text: "Send the Concordium account address to check." };
        const e = await ops.eligibility(r.account);
        return { text: e.eligible ? `${r.account} has passed the zero-knowledge eligibility check.` : `${r.account} has not passed the eligibility check; its owner can verify once at ${e.verify_url}.`, data: e };
      }
      case "how_to_buy": {
        const b = await ops.howToBuy(opts.selfUrl);
        return { text: `Pay over x402 at ${b.endpoint} with your own wallet (testnet CCD, fees sponsored); prove eligibility first and verify the seller's on-chain agentWallet. Terms in the data part.`, data: b };
      }
      default:
        return { text: HELP };
    }
  }

  app.post("/a2a", async (req: Request, res: Response) => {
    const body = req.body as { jsonrpc?: string; id?: string | number | null; method?: string; params?: { message?: IncomingMessage } };
    const id = body?.id ?? null;
    const error = (code: number, message: string) => res.json({ jsonrpc: "2.0", id, error: { code, message } });
    if (body?.jsonrpc !== "2.0" || typeof body.method !== "string") return error(-32600, "Invalid JSON-RPC request");
    if (body.method !== "message/send")
      return error(-32601, `Method not found: ${body.method} (this agent answers message/send; it is stateless, no tasks)`);
    const msg = body.params?.message;
    if (!msg || !Array.isArray(msg.parts)) return error(-32602, "params.message with parts is required");
    try {
      const out = await answer(msg);
      res.json({
        jsonrpc: "2.0",
        id,
        result: {
          kind: "message",
          role: "agent",
          messageId: randomUUID(),
          contextId: typeof msg.contextId === "string" ? msg.contextId : randomUUID(),
          parts: [{ kind: "text", text: out.text }, ...(out.data === undefined ? [] : [{ kind: "data", data: out.data }])],
        },
      });
    } catch (e) {
      error(-32603, `Internal error: ${errText(e)}`);
    }
  });
  app.get("/a2a", (_req, res) => res.status(405).set("Allow", "POST").json({ error: "POST a JSON-RPC 2.0 message/send request; the Agent Card is at /.well-known/agent-card.json" }));
}
