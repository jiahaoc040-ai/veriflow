/**
 * 每日公開訊號
 * ------------
 * 「沒人能造假的績效紀錄」需要每天都有紀錄，不能只靠有人付費購買。
 * 這個排程定期（預設每 30 分鐘）對每個資產呼叫 API 的 /daily/{asset}：
 *   - API 決定「最新收盤日」，那一天還沒有上鏈的訊號才發新的
 *   - 拿到承諾雜湊後上鏈（合約 commit 或 register data），再回報交易給 API
 *   - 上鏈失敗就留到下一輪重試；同一天不會重複上鏈
 * 訊號內容跟付費訊號一樣，7 天後公開並計分。
 */

export type DailyDeps = {
  apiUrl: string;
  secret: string;
  assets: string[];
  anchor: (commitment: string, asset: string) => Promise<string>;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
};

export type DailyResult = { asset: string; status: string; as_of?: string; tx?: string; error?: string };

export async function runDailyOnce(d: DailyDeps): Promise<DailyResult[]> {
  const f = d.fetch ?? fetch;
  const headers = { "X-VeriFlow-Gateway": d.secret, "Content-Type": "application/json" };
  const out: DailyResult[] = [];
  for (const asset of d.assets) {
    try {
      const r = await f(`${d.apiUrl}/daily/${asset}`, { method: "POST", headers });
      if (!r.ok) throw new Error(`/daily/${asset} → HTTP ${r.status}`);
      const body = (await r.json()) as { status: string; as_of?: string; commitment?: string };
      if (body.status === "exists" || !body.commitment) {
        out.push({ asset, status: body.status, as_of: body.as_of });
        continue;
      }
      const tx = await d.anchor(body.commitment, asset);
      const a = await f(`${d.apiUrl}/commitments/${body.commitment}/anchor`, {
        method: "POST",
        headers,
        body: JSON.stringify({ anchor_tx: tx }),
      });
      if (!a.ok) throw new Error(`anchor report → HTTP ${a.status}`);
      out.push({ asset, status: "anchored", as_of: body.as_of, tx });
      d.log?.(`daily signal ${asset} ${body.as_of} anchored → ${tx}`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      out.push({ asset, status: "error", error });
      d.log?.(`daily signal ${asset} failed (will retry next round): ${error}`);
    }
  }
  return out;
}

/** 啟動排程：第一次延遲 firstDelayMs（讓 API 先把價格抓好），之後每 intervalMs 一次；不會同時跑兩輪 */
export function startDailySignals(d: DailyDeps, intervalMs: number, firstDelayMs = 60_000, reveals?: RevealDeps) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDailyOnce(d);
      if (reveals) await runRevealsOnce(reveals).catch((e) => d.log?.(`reveal round failed: ${e instanceof Error ? e.message : String(e)}`));
    } finally {
      running = false;
    }
  };
  const first = setTimeout(tick, firstDelayMs);
  const every = setInterval(tick, intervalMs);
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

/**
 * 到期自動公開（reveal）
 * --------------------
 * 合約規定：commit 之後滿 horizon（7 天）任何人都能 reveal，合約自己重算 SHA-256 才接受。
 * 這裡讓伺服器自己做：每一輪找出「在合約裡、已過 horizon、還沒公開」的承諾，把內容送上鏈。
 * 不在合約裡的（早期用 register data 上鏈的）跳過；每輪最多 max 筆，避免一次花太多手續費。
 */
export type RevealDeps = {
  apiUrl: string;
  /** null＝合約裡沒有這個承諾 */
  record: (commitment: string) => Promise<{ committed_at: string; reveal: unknown | null } | null>;
  reveal: (canonical: string) => Promise<string>;
  horizonMs?: number;
  max?: number;
  now?: () => number;
  fetch?: typeof fetch;
  log?: (msg: string) => void;
};

export type RevealResult = { commitment: string; status: "revealed" | "error"; tx?: string; error?: string };

export async function runRevealsOnce(d: RevealDeps): Promise<RevealResult[]> {
  const f = d.fetch ?? fetch;
  const now = (d.now ?? Date.now)();
  const horizon = d.horizonMs ?? 7 * 86_400_000;
  const max = d.max ?? 5;
  const r = await f(`${d.apiUrl}/commitments`);
  if (!r.ok) throw new Error(`/commitments → HTTP ${r.status}`);
  const rows = (await r.json()) as { commitment: string; anchor_tx?: string | null }[];
  const out: RevealResult[] = [];
  for (const row of rows) {
    if (out.length >= max) break;
    if (!row.anchor_tx) continue;
    let rec: { committed_at: string; reveal: unknown | null } | null;
    try {
      rec = await d.record(row.commitment);
    } catch {
      continue; // 這一輪查不到（節點暫時連不上），下一輪再試
    }
    if (!rec || rec.reveal) continue; // 不在合約裡（register data 時期的承諾）或已經公開
    if (now < Date.parse(rec.committed_at) + horizon + 60_000) continue; // 多等一分鐘，避開區塊時間誤差
    try {
      const c = await f(`${d.apiUrl}/commitments/${row.commitment}`);
      const canonical = c.ok ? ((await c.json()) as { canonical?: string }).canonical : undefined;
      if (!canonical) continue; // API 還沒公開內容
      const tx = await d.reveal(canonical);
      out.push({ commitment: row.commitment, status: "revealed", tx });
      d.log?.(`revealed ${row.commitment.slice(0, 12)}… on-chain → ${tx}`);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      out.push({ commitment: row.commitment, status: "error", error });
      d.log?.(`reveal ${row.commitment.slice(0, 12)}… failed (will retry next round): ${error}`);
    }
  }
  return out;
}
