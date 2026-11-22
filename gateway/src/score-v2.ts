/**
 * VeriFlow scoring rule v2 — the executable rule for contract v2 (docs/SCORING-v2.md).
 * ------------------------------------------------------------------------------------
 * Inputs: contract v2 state from any Concordium node (per-slot getter and summary) and Binance spot
 * daily candles (data-api.binance.vision). Nothing from VeriFlow's API, database or an indexer.
 * No flags change the result.
 *
 *   npm run score2                   report (score-v2-report.json)
 *   npm run score2 -- --spec-hash    SHA-256 of docs/SCORING-v2.md and this file
 *   npm run score2 -- --anchor-spec  owner registers veriflow:scoring:v2:<contract>:<module>:<spec>:<script>
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SlotV2, SummaryV2 } from "./contract-v2.js";
import { roundHalfAway, type Candle } from "./signal-v2.js";

export const RULE_V2 = {
  version: "v2",
  // Filled in from the deployment before this file is hashed; changing any of them is a new rule.
  contractIndex: 0n,
  moduleRef: "",
  initTx: "",
  assets: ["BTC", "ETH"] as const,
  horizonDays: 7,
  lookbackDays: 30,
  binance: "https://data-api.binance.vision/api/v3/klines",
  symbols: { BTC: "BTCUSDT", ETH: "ETHUSDT" } as Record<string, string>,
};
type Rule = typeof RULE_V2;

const DAY = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const addDays = (d: string, n: number) => dayOf(dayMs(d) + n * DAY);
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export type Failure = { as_of: string; asset: string; reason: string };
export type Slots = Map<string, SlotV2>; // key `${asset}|${as_of}`

/**
 * Required slots: every as_of whose commit window [as_of+1d, as_of+2d) closes after the contract's
 * init time and no later than the run. A slot whose window is still open is counted only if present.
 */
export function requiredDays(initTime: string, nowMs: number): string[] {
  const out: string[] = [];
  const init = Date.parse(initTime);
  for (let d = dayOf(init - 2 * DAY); dayMs(d) + 2 * DAY <= nowMs; d = addDays(d, 1)) if (dayMs(d) + 2 * DAY > init) out.push(d);
  return out;
}

export function scoreV2(summary: SummaryV2, slots: Slots, prices: Record<string, Candle[]>, nowMs: number, rule: Rule = RULE_V2, identity: string[] = []) {
  const days = requiredDays(summary.init_time, nowMs);
  const assets = rule.assets as readonly string[];
  const close = (asset: string, d: string) => (prices[asset] ?? []).find((k) => k.openTime === dayMs(d) && k.closeTime < nowMs)?.close;
  const failures: Failure[] = [];
  const pending: string[] = [];
  const problems: string[] = [...identity];

  // completeness: the contract's own counter must equal the slots found (required ones plus any in an open window)
  const openDay = addDays(dayOf(nowMs), -1);
  const found = [...slots.keys()].length;
  if (found !== summary.issued) problems.push(`found ${found} slots, contract issued counter says ${summary.issued}`);
  if (summary.horizon_ms !== rule.horizonDays * DAY) problems.push(`contract horizon ${summary.horizon_ms} ms`);
  for (const k of slots.keys()) {
    const d = k.split("|")[1];
    if (!days.includes(d) && d !== openDay) problems.push(`slot ${k} is outside the required window`);
  }

  type Row = { as_of: string; book: number; on: number; labels: Record<string, string> };
  const rows: Row[] = [];
  let revealDue = 0;
  let revealOk = 0;
  for (const d of days) {
    const exitDay = addDays(d, 1 + rule.horizonDays);
    const exitClosed = nowMs >= dayMs(exitDay) + DAY;
    const legs: { asset: string; r: number; on: boolean }[] = [];
    let blocked = false;
    for (const a of assets) {
      const s = slots.get(`${a}|${d}`);
      if (!s) {
        failures.push({ as_of: d, asset: a, reason: "no commit" });
        blocked = true;
        continue;
      }
      if (!exitClosed) continue;
      revealDue++;
      if (!s.reveal) {
        failures.push({ as_of: d, asset: a, reason: "exit candle closed but the call is not revealed" });
        blocked = true;
        continue;
      }
      // recompute momentum_e6 from Binance; the contract already enforced signal == (momentum_e6 > 0)
      const revealed = JSON.parse(s.reveal.canonical) as { momentum_e6: number };
      const now = close(a, d);
      const then = close(a, addDays(d, -rule.lookbackDays));
      if (now === undefined || then === undefined) {
        failures.push({ as_of: d, asset: a, reason: "Binance candle missing for momentum" });
        blocked = true;
        continue;
      }
      const m = roundHalfAway((now / then - 1) * 1e6);
      if (m !== revealed.momentum_e6) {
        failures.push({ as_of: d, asset: a, reason: `momentum_e6 ${revealed.momentum_e6} ≠ ${m} recomputed from Binance` });
        blocked = true;
        continue;
      }
      revealOk++;
      const entry = close(a, addDays(d, 1));
      const exit = close(a, exitDay);
      if (entry === undefined || exit === undefined) {
        failures.push({ as_of: d, asset: a, reason: "Binance candle missing for entry or exit" });
        blocked = true;
        continue;
      }
      legs.push({ asset: a, r: exit / entry - 1, on: s.reveal.signal === "RISK_ON" });
    }
    if (!exitClosed && !blocked) pending.push(d);
    if (exitClosed && !blocked && legs.length === assets.length)
      rows.push({
        as_of: d,
        book: legs.reduce((x, l) => x + (l.on ? l.r : 0), 0) / legs.length,
        on: legs.reduce((x, l) => x + l.r, 0) / legs.length,
        labels: Object.fromEntries(legs.map((l) => [l.asset, l.on ? "RISK_ON" : "RISK_OFF"])),
      });
  }
  const goodSlots = days.length * assets.length - failures.filter((f) => f.reason === "no commit").length;
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const published = problems.length === 0 && failures.length === 0 && rows.length > 0;
  const mS = rows.length ? mean(rows.map((x) => x.book)) : NaN;
  const mOn = rows.length ? mean(rows.map((x) => x.on)) : NaN;
  return {
    rule: rule.version,
    contract: `<${rule.contractIndex},0>`,
    run_at: new Date(nowMs).toISOString(),
    complete: problems.length === 0,
    problems,
    integrity: {
      window: days.length ? [days[0], days[days.length - 1]] : [],
      commit: { numerator: goodSlots, denominator: days.length * assets.length },
      reveal: { numerator: revealOk, denominator: revealDue },
      failures,
    },
    performance: published
      ? {
          published: true,
          unit: "mean of overlapping 7-day returns (exit close / entry close − 1), not a daily return",
          scored_days: rows.length,
          risk_off_calls: rows.reduce((s, x) => s + Object.values(x.labels).filter((l) => l === "RISK_OFF").length, 0),
          label_switches: Object.fromEntries(assets.map((a) => [a, rows.slice(1).filter((x, i) => x.labels[a] !== rows[i].labels[a]).length])),
          mean_7d_return_signal: r6(mS),
          mean_7d_return_always_on: r6(mOn),
          mean_7d_return_always_off: 0,
          x_vs_always_on: r6(mS - mOn),
          x_vs_always_off: r6(mS),
          pending_days: pending,
          caveat:
            "7-day returns overlap and BTC and ETH move together; independent observations are far fewer than scored days. If the labels never switched, this cannot be told apart from a constant.",
        }
      : {
          published: false,
          reason: problems.length
            ? `INCOMPLETE: ${problems.join("; ")}`
            : failures.length
              ? `blocked: ${failures.map((f) => `${f.as_of} ${f.asset} (${f.reason})`).join(", ")}`
              : "no scored day yet",
          pending_days: pending,
        },
  };
}

// ── inputs ──
async function collect(nowMs: number) {
  const { ContractAddress } = await import("@concordium/web-sdk");
  const { createV2Reader } = await import("./contract-v2.js");
  const { binanceDaily } = await import("./signal-v2.js");
  const { TransactionHash } = await import("@concordium/web-sdk");
  const address = ContractAddress.create(RULE_V2.contractIndex, 0n);
  const reader = createV2Reader(address);
  const summary = await reader.summary();
  // identity: this instance was created by the named init tx, from the named module
  const identity: string[] = [];
  const info = (await reader.grpc.getInstanceInfo(address)) as any;
  const mod = String(info?.sourceModule?.moduleRef ?? info?.sourceModule ?? "");
  if (!mod.includes(RULE_V2.moduleRef)) identity.push(`instance module ${mod} ≠ ${RULE_V2.moduleRef}`);
  const st = (await reader.grpc.getBlockItemStatus(TransactionHash.fromHexString(RULE_V2.initTx))) as any;
  const init = st?.outcome?.summary?.contractInitialized ?? st?.outcomes?.[0]?.summary?.contractInitialized;
  if (st?.status !== "finalized" || BigInt(init?.address?.index ?? -1) !== RULE_V2.contractIndex) identity.push(`init tx ${RULE_V2.initTx.slice(0, 12)}… did not create <${RULE_V2.contractIndex},0>`);
  const slots: Slots = new Map();
  const days = [...requiredDays(summary.init_time, nowMs), addDays(dayOf(nowMs), -1)];
  for (const d of new Set(days))
    for (const a of RULE_V2.assets) {
      const s = await reader.slot(a, d);
      if (s) slots.set(`${a}|${d}`, s);
    }
  const since = addDays(dayOf(Date.parse(summary.init_time)), -(RULE_V2.lookbackDays + 5));
  const prices = Object.fromEntries(await Promise.all(RULE_V2.assets.map(async (a) => [a, await binanceDaily(a, since, nowMs)])));
  return { summary, slots, prices, identity };
}

const here = fileURLToPath(import.meta.url);
export function specHashesV2() {
  const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
  const spec = sha(fileURLToPath(new URL("../../docs/SCORING-v2.md", import.meta.url)));
  const script = sha(here);
  return { spec, script, data: `veriflow:scoring:v2:${RULE_V2.contractIndex}:${RULE_V2.moduleRef}:${spec}:${script}` };
}

async function anchorSpec() {
  if (!RULE_V2.contractIndex || !RULE_V2.moduleRef || !RULE_V2.initTx) throw new Error("rule constants are not filled in");
  const { DataBlob, SequenceNumber, TransactionExpiry, TransactionHash } = await import("@concordium/web-sdk");
  const { Transaction } = await import("@concordium/web-sdk/transactions");
  const { env, loadAccount } = await import("./config.js");
  const { createGrpc } = await import("./grpc.js");
  const { data } = specHashesV2();
  const account = loadAccount(env("REGISTRY_OWNER_KEY_FILE", env("FACILITATOR_KEY_FILE")));
  const grpc = createGrpc();
  const nonce = (await grpc.getNextAccountNonce(account.accountAddress)).nonce;
  const tx = Transaction.registerData({ data: new DataBlob(new TextEncoder().encode(data).buffer as ArrayBuffer) })
    .addMetadata({ sender: account.accountAddress, nonce: SequenceNumber.create(nonce.value), expiry: TransactionExpiry.futureMinutes(5) })
    .build();
  const hash = TransactionHash.toHexString(await grpc.sendTransaction(await Transaction.signAndFinalize(tx, account.signer)));
  console.log(`sender ${account.address}\ndata   ${data}\ntx     https://ccdexplorer.io/testnet/transaction/${hash}`);
}

async function main() {
  const arg = process.argv[2];
  if (arg === "--spec-hash") return console.log(JSON.stringify(specHashesV2(), null, 2));
  if (arg === "--anchor-spec") return anchorSpec();
  if (arg) throw new Error(`unknown argument ${arg} (the rule has no flags)`);
  if (!RULE_V2.contractIndex) throw new Error("rule constants are not filled in yet");
  const now = Date.now();
  const { summary, slots, prices, identity } = await collect(now);
  const rep = scoreV2(summary, slots, prices, now, RULE_V2, identity);
  writeFileSync("score-v2-report.json", JSON.stringify({ ...rep, hashes: specHashesV2() }, null, 2));
  const i = rep.integrity;
  console.log(`VeriFlow scoring rule v2 — contract ${rep.contract} — run ${rep.run_at}`);
  console.log(`completeness: ${rep.complete ? "complete" : `INCOMPLETE (${rep.problems.join("; ")})`}`);
  console.log(`commit integrity ${i.window.join("..")}: ${i.commit.numerator}/${i.commit.denominator}`);
  console.log(`reveal integrity: ${i.reveal.numerator}/${i.reveal.denominator}`);
  for (const f of i.failures) console.log(`  ✗ ${f.as_of} ${f.asset}: ${f.reason}`);
  const p = rep.performance as any;
  if (!p.published) console.log(`performance: not published — ${p.reason}`);
  else
    console.log(
      `performance: ${p.scored_days} scored days, ${p.risk_off_calls} RISK_OFF calls, switches ${JSON.stringify(p.label_switches)}\n` +
        `  mean 7-day return: signal ${p.mean_7d_return_signal}  always_on ${p.mean_7d_return_always_on}  always_off 0\n` +
        `  x_vs_always_on ${p.x_vs_always_on}  x_vs_always_off ${p.x_vs_always_off}\n  ${p.caveat}`,
    );
}

if (process.argv[1] && fileURLToPath(`file://${process.argv[1]}`) === here) {
  main().then(() => process.exit(0), (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
