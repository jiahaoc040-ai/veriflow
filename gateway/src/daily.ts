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
export function startDailySignals(d: DailyDeps, intervalMs: number, firstDelayMs = 60_000) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDailyOnce(d);
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
