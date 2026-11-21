/**
 * VeriFlow scoring rule v1 — the executable rule (docs/SCORING.md).
 * -----------------------------------------------------------------
 * 只讀三種輸入：合約狀態（任何 Concordium 節點的 gRPC）、CCDScan 的 Committed 事件（只用來列出有哪些承諾，
 * 數量必須等於合約自己的 issued 計數）、Binance 現貨日 K（data-api.binance.vision）。
 * 不讀 VeriFlow 自己的 API、資料庫或價格。沒有任何參數會改變結果。
 *
 *   npm run score                 計分並輸出報告（score-report.json）
 *   npm run score -- --spec-hash  印出 SCORING.md 與本檔的 SHA-256（要上鏈的字串）
 *   npm run score -- --anchor-spec  由擁有者帳號把上面的字串以 register data 上鏈（FACILITATOR_KEY_FILE）
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ── 規則常數（改任何一個都等於換一份規則，雜湊會變） ─────────────────────────────
export const RULE = {
  version: "v1",
  contract: { index: 13094n, subindex: 0n },
  assets: ["BTC", "ETH"] as const,
  integrityStart: "2026-11-20",
  performanceStart: "2026-11-20", // = integrityStart：11/20 已失敗，所以這個合約不發布績效數字
  horizonDays: 7,
  graceDays: 1,
  boundaryTolerance: 1e-6,
  ccdscan: "https://api-ccdscan-fungy.testnet.concordium.com/api/graphql",
  binance: "https://data-api.binance.vision/api/v3/klines",
  symbols: { BTC: "BTCUSDT", ETH: "ETHUSDT" } as Record<string, string>,
};

const DAY = 86_400_000;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const addDays = (d: string, n: number) => dayOf(dayMs(d) + n * DAY);
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export type Commit = {
  commitment: string;
  asset: string;
  committed_at: string; // ISO, from contract state
  reveal: null | { signal: "RISK_ON" | "RISK_OFF"; canonical: string };
};
export type Candle = { openTime: number; closeTime: number; close: number };
export type Discovery = { complete: boolean; issued: number; listed: number; problems: string[] };

type Failure = { day: string; asset: string; reason: string; commitments: string[] };

/** 公開內容是否符合承諾與規則；回傳失敗原因（空陣列＝通過） */
export function revealProblems(c: Commit): string[] {
  if (!c.reveal) return ["due but not revealed"];
  let s: Record<string, unknown>;
  try {
    s = JSON.parse(c.reveal.canonical);
  } catch {
    return ["revealed text is not JSON"];
  }
  const out: string[] = [];
  if (s.asset !== c.asset) out.push(`revealed asset ${String(s.asset)} ≠ committed asset ${c.asset}`);
  const want = addDays(dayOf(Date.parse(c.committed_at)), -1);
  if (s.as_of !== want) out.push(`as_of ${String(s.as_of)} is not the day before the commit's block day (${want})`);
  const m = Number(s.momentum);
  const z = Number(s.liquidity_z);
  if (!Number.isFinite(m) || !Number.isFinite(z)) out.push("momentum or liquidity_z missing");
  else {
    const tol = RULE.boundaryTolerance;
    const onBoundary = Math.abs(m) <= tol || Math.abs(z + 1) <= tol;
    const rule = m > 0 && z > -1 ? "RISK_ON" : "RISK_OFF";
    if (!onBoundary && s.signal !== rule) out.push(`signal ${String(s.signal)} ≠ rule (${rule})`);
  }
  if (s.signal !== c.reveal.signal) out.push("revealed signal differs from the contract's parsed signal");
  return out;
}

/** 計分：純函式，同樣的輸入永遠得到同樣的報告 */
/** rule 參數只給測試用；命令列一律用 RULE（沒有任何旗標） */
export function score(commits: Commit[], prices: Record<string, Candle[]>, discovery: Discovery, nowMs: number, rule: typeof RULE = RULE) {
  const end = addDays(dayOf(nowMs), -1); // 最後一個完整的 UTC 日
  const assets = rule.assets as readonly string[];
  const days: string[] = [];
  for (let d = rule.integrityStart; d <= end; d = addDays(d, 1)) days.push(d);

  // ── commit integrity ──
  const inWindow = commits.filter((c) => {
    const d = dayOf(Date.parse(c.committed_at));
    return d >= rule.integrityStart && d <= end;
  });
  const slot = new Map<string, Commit[]>();
  const foreign: Commit[] = [];
  for (const c of inWindow) {
    if (!assets.includes(c.asset)) foreign.push(c);
    else {
      const k = `${dayOf(Date.parse(c.committed_at))}|${c.asset}`;
      slot.set(k, [...(slot.get(k) ?? []), c]);
    }
  }
  const slotFailures: Failure[] = [];
  let goodSlots = 0;
  for (const d of days)
    for (const a of assets) {
      const cs = slot.get(`${d}|${a}`) ?? [];
      if (cs.length === 1) goodSlots++;
      else
        slotFailures.push({
          day: d,
          asset: a,
          reason: cs.length === 0 ? "no commit" : `${cs.length} commits`,
          commitments: cs.map((c) => c.commitment),
        });
    }
  const foreignFailures: Failure[] = foreign.map((c) => ({
    day: dayOf(Date.parse(c.committed_at)),
    asset: c.asset,
    reason: "asset is not BTC or ETH",
    commitments: [c.commitment],
  }));

  // ── reveal integrity ──
  const dueMs = (c: Commit) => Date.parse(c.committed_at) + (rule.horizonDays + rule.graceDays) * DAY;
  const due = inWindow.filter((c) => nowMs > dueMs(c));
  const revealFailures: Failure[] = [];
  for (const c of due) {
    const p = revealProblems(c);
    if (p.length) revealFailures.push({ day: dayOf(Date.parse(c.committed_at)), asset: c.asset, reason: p.join("; "), commitments: [c.commitment] });
  }

  // ── performance ──
  const perfBlockers = [...slotFailures, ...foreignFailures, ...revealFailures].filter((f) => f.day >= rule.performanceStart);
  // 進場＝承諾區塊日那根日 K（收盤時間一定晚於區塊時間）；出場＝7 根之後那根。缺一根＝缺口，不往後順延
  const at = (asset: string, openTime: number) => (prices[asset] ?? []).find((k) => k.openTime === openTime && k.closeTime < nowMs) ?? null;
  type Row = { day: string; book: number; on: number; labels: Record<string, string> };
  const rows: Row[] = [];
  const pending: string[] = [];
  const gaps: string[] = [];
  const blocked: Failure[] = [];
  for (const d of days.filter((x) => x >= rule.performanceStart)) {
    const calls = assets.map((a) => slot.get(`${d}|${a}`) ?? []);
    if (calls.some((cs) => cs.length !== 1)) continue; // 已經是 slot failure，會擋住發布
    const legs = calls.map(([c]) => {
      const entryOpen = dayMs(dayOf(Date.parse(c.committed_at)));
      const exitOpen = entryOpen + rule.horizonDays * DAY;
      return { c, exitClosesAt: exitOpen + DAY - 1, entry: at(c.asset, entryOpen), exit: at(c.asset, exitOpen) };
    });
    // 只有出場 K 線還沒收盤才算 pending；收盤之後不是計入就是擋住，不能被略過
    if (legs.some((l) => nowMs <= l.exitClosesAt)) {
      pending.push(d);
      continue;
    }
    const unrevealed = legs.filter((l) => !l.c.reveal);
    if (unrevealed.length) {
      for (const l of unrevealed)
        blocked.push({ day: d, asset: l.c.asset, reason: "exit candle closed but the call is not revealed", commitments: [l.c.commitment] });
      continue;
    }
    const missing = legs.filter((l) => !l.entry || !l.exit);
    if (missing.length) {
      gaps.push(d);
      for (const l of missing) blocked.push({ day: d, asset: l.c.asset, reason: "Binance candle missing (gap)", commitments: [l.c.commitment] });
      continue;
    }
    const r = legs.map((l) => l.exit!.close / l.entry!.close - 1);
    const pos = legs.map((l, i) => (l.c.reveal!.signal === "RISK_ON" ? r[i] : 0));
    rows.push({
      day: d,
      book: (pos[0] + pos[1]) / 2,
      on: (r[0] + r[1]) / 2,
      labels: Object.fromEntries(legs.map((l) => [l.c.asset, l.c.reveal!.signal])),
    });
  }
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN);
  const switches = Object.fromEntries(
    assets.map((a) => [a, rows.slice(1).filter((row, i) => row.labels[a] !== rows[i].labels[a]).length]),
  );
  const allBlockers = [...perfBlockers, ...blocked];
  const published = discovery.complete && allBlockers.length === 0 && rows.length > 0;
  const mSignal = mean(rows.map((x) => x.book));
  const mOn = mean(rows.map((x) => x.on));

  return {
    rule: rule.version,
    contract: `<${rule.contract.index},${rule.contract.subindex}>`,
    run_at: new Date(nowMs).toISOString(),
    discovery,
    integrity: {
      window: [rule.integrityStart, end],
      commit: { numerator: goodSlots, denominator: days.length * assets.length + foreign.length },
      reveal: { numerator: due.length - revealFailures.length, denominator: due.length, pending: inWindow.length - due.length },
      failures: [...slotFailures, ...foreignFailures, ...revealFailures].sort((a, b) => a.day.localeCompare(b.day)),
    },
    performance: published
      ? {
          published: true,
          window_start: rule.performanceStart,
          scored_days: rows.length,
          risk_off_calls: rows.reduce((s, x) => s + Object.values(x.labels).filter((l) => l === "RISK_OFF").length, 0),
          label_switches: switches,
          unit: "mean of overlapping 7-day returns (exit close / entry close − 1), not a daily return",
          mean_7d_return_signal: r6(mSignal),
          mean_7d_return_always_on: r6(mOn),
          mean_7d_return_always_off: 0,
          x_vs_always_on: r6(mSignal - mOn),
          x_vs_always_off: r6(mSignal),
          pending_days: pending,
          gap_days: gaps,
          caveat:
            "7-day returns overlap and BTC and ETH move together; independent observations are far fewer than scored days. If the labels never switched, this cannot be told apart from a constant.",
        }
      : {
          published: false,
          window_start: rule.performanceStart,
          reason: !discovery.complete
            ? "discovery INCOMPLETE"
            : allBlockers.length
              ? `blocked inside the performance window: ${allBlockers.map((f) => `${f.day} ${f.asset} (${f.reason})`).join(", ")}`
              : "no scored day yet",
          pending_days: pending,
          gap_days: gaps,
        },
  };
}

// ── 輸入（只讀）────────────────────────────────────────────────────────────────
async function ccdscanCommitted(): Promise<{ commitment: string; asset: string }[]> {
  const { decodeCommittedEvent } = await import("./contract.js");
  const out: { commitment: string; asset: string }[] = [];
  for (let skip = 0; ; skip += 50) {
    const query = `{ contract(contractAddressIndex: ${RULE.contract.index}, contractAddressSubIndex: ${RULE.contract.subindex}) {
      contractEvents(skip: ${skip}, take: 50) { totalCount items { event { __typename ... on ContractUpdated { receiveName eventsAsHex { nodes } } } } } } }`;
    const r = await fetch(RULE.ccdscan, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) });
    if (!r.ok) throw new Error(`CCDScan HTTP ${r.status}`);
    const j = (await r.json()) as any;
    if (j.errors) throw new Error(`CCDScan: ${JSON.stringify(j.errors).slice(0, 300)}`);
    const ev = j.data.contract.contractEvents;
    for (const it of ev.items) {
      if (it.event.__typename !== "ContractUpdated" || it.event.receiveName !== "veriflow_registry.commit") continue;
      for (const hex of it.event.eventsAsHex?.nodes ?? []) {
        const c = decodeCommittedEvent(hex);
        if (c) out.push(c);
      }
    }
    if (skip + 50 >= ev.totalCount) break;
  }
  return out;
}

async function contractState(list: { commitment: string; asset: string }[]) {
  const { ContractAddress, ContractName, EntrypointName, Parameter, ReceiveName, ReturnValue } = await import("@concordium/web-sdk");
  const { createGrpc } = await import("./grpc.js");
  const { decodeCommitmentRecord, decodeSummary, encodeCommitmentKey, CONTRACT_NAME } = await import("./contract.js");
  const grpc = createGrpc();
  const contract = ContractAddress.create(RULE.contract.index, RULE.contract.subindex);
  const view = async (entry: string, param: Buffer) => {
    const res = await grpc.invokeContract({
      contract,
      method: ReceiveName.create(ContractName.fromString(CONTRACT_NAME), EntrypointName.fromString(entry)),
      parameter: Parameter.fromBuffer(new Uint8Array(param).buffer as ArrayBuffer),
    });
    if (res.tag !== "success" || !res.returnValue) throw new Error(`${entry} view failed`);
    return Buffer.from(ReturnValue.toHexString(res.returnValue), "hex");
  };
  const summary = decodeSummary(await view("view", Buffer.alloc(0)));
  const problems: string[] = [];
  const unique = [...new Map(list.map((c) => [c.commitment, c])).values()];
  if (unique.length !== list.length) problems.push(`indexer listed ${list.length - unique.length} duplicate events`);
  if (unique.length !== summary.issued) problems.push(`indexer lists ${unique.length} commits, contract issued counter says ${summary.issued}`);
  if (summary.horizon_days !== RULE.horizonDays) problems.push(`contract horizon is ${summary.horizon_days} days, rule says ${RULE.horizonDays}`);
  const commits: Commit[] = [];
  for (const c of unique) {
    const rec = decodeCommitmentRecord(await view("commitment", encodeCommitmentKey(c.commitment)));
    if (!rec) {
      problems.push(`${c.commitment.slice(0, 12)}… listed by the indexer but not in contract state`);
      continue;
    }
    if (rec.asset !== c.asset) problems.push(`${c.commitment.slice(0, 12)}… asset differs between event and state`);
    commits.push({
      commitment: c.commitment,
      asset: rec.asset,
      committed_at: rec.committed_at,
      reveal: rec.reveal ? { signal: rec.reveal.signal, canonical: rec.reveal.canonical } : null,
    });
  }
  return { commits, discovery: { complete: problems.length === 0, issued: summary.issued, listed: unique.length, problems } };
}

async function binanceDaily(symbol: string): Promise<Candle[]> {
  const url = `${RULE.binance}?symbol=${symbol}&interval=1d&startTime=${dayMs(RULE.integrityStart)}&limit=1000`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Binance ${symbol} HTTP ${r.status}`);
  const rows = (await r.json()) as unknown[][];
  return rows.map((k) => ({ openTime: Number(k[0]), closeTime: Number(k[6]), close: Number(k[4]) }));
}

// ── 規則雜湊與上鏈 ─────────────────────────────────────────────────────────────
const here = fileURLToPath(import.meta.url);
export function specHashes() {
  const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
  const spec = sha(fileURLToPath(new URL("../../docs/SCORING.md", import.meta.url)));
  const script = sha(here);
  return { spec, script, data: `veriflow:scoring:${RULE.version}:${spec}:${script}` };
}

async function anchorSpec() {
  const { DataBlob, SequenceNumber, TransactionExpiry, TransactionHash } = await import("@concordium/web-sdk");
  const { Transaction } = await import("@concordium/web-sdk/transactions");
  const { env, loadAccount } = await import("./config.js");
  const { createGrpc } = await import("./grpc.js");
  const { data } = specHashes();
  const account = loadAccount(env("FACILITATOR_KEY_FILE"));
  const grpc = createGrpc();
  const nonce = (await grpc.getNextAccountNonce(account.accountAddress)).nonce;
  const tx = Transaction.registerData({ data: new DataBlob(new TextEncoder().encode(data).buffer as ArrayBuffer) })
    .addMetadata({ sender: account.accountAddress, nonce: SequenceNumber.create(nonce.value), expiry: TransactionExpiry.futureMinutes(5) })
    .build();
  const hash = TransactionHash.toHexString(await grpc.sendTransaction(await Transaction.signAndFinalize(tx, account.signer)));
  console.log(`sender ${account.address}\ndata   ${data}\ntx     https://ccdexplorer.io/testnet/transaction/${hash}`);
}

function print(rep: ReturnType<typeof score>) {
  const i = rep.integrity;
  console.log(`VeriFlow scoring rule ${rep.rule} — contract ${rep.contract} — run ${rep.run_at}`);
  console.log(`discovery: ${rep.discovery.complete ? "complete" : "INCOMPLETE"} (${rep.discovery.listed} listed, contract issued ${rep.discovery.issued})${rep.discovery.problems.map((p) => `\n  - ${p}`).join("")}`);
  console.log(`commit integrity ${i.window[0]}..${i.window[1]}: ${i.commit.numerator}/${i.commit.denominator}`);
  console.log(`reveal integrity: ${i.reveal.numerator}/${i.reveal.denominator} due (${i.reveal.pending} not yet due)`);
  for (const f of i.failures) console.log(`  ✗ ${f.day} ${f.asset}: ${f.reason}${f.commitments.length ? ` [${f.commitments.map((c) => c.slice(0, 8)).join(", ")}]` : ""}`);
  const p = rep.performance;
  if (!p.published) console.log(`performance: not published — ${p.reason}`);
  else
    console.log(
      `performance from ${p.window_start}: ${p.scored_days} scored days, ${p.risk_off_calls} RISK_OFF calls, switches ${JSON.stringify(p.label_switches)}\n` +
        `  mean 7-day return: signal ${p.mean_7d_return_signal}  always_on ${p.mean_7d_return_always_on}  always_off 0\n` +
        `  x_vs_always_on ${p.x_vs_always_on}  x_vs_always_off ${p.x_vs_always_off}\n  ${p.caveat}`,
    );
}

async function main() {
  const arg = process.argv[2];
  if (arg === "--spec-hash") return console.log(JSON.stringify(specHashes(), null, 2));
  if (arg === "--anchor-spec") return anchorSpec();
  if (arg) throw new Error(`unknown argument ${arg} (the rule has no flags)`);
  const listed = await ccdscanCommitted();
  const { commits, discovery } = await contractState(listed);
  const prices = Object.fromEntries(await Promise.all(Object.entries(RULE.symbols).map(async ([a, s]) => [a, await binanceDaily(s)])));
  const rep = score(commits, prices, discovery, Date.now());
  writeFileSync("score-report.json", JSON.stringify({ ...rep, hashes: specHashes() }, null, 2));
  print(rep);
}

if (process.argv[1] && fileURLToPath(`file://${process.argv[1]}`) === here) {
  main().then(() => process.exit(0), (e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
