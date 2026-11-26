/**
 * "Check another team's seller": fixed list only, cached, never pays. Fake deps, no network beyond localhost
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { guardPresetRouter, presets } from "../src/guard-presets.ts";
import type { GuardDeps } from "../src/guard.ts";

test("only the fixed list can be checked; results are cached; a seller error is reported without details", async () => {
  let calls = 0;
  const pr = Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: "x" }, accepts: [{ scheme: "exact", network: "ccd:4221332d34e1694168c2a0c0b3fd0f27", amount: "1", asset: "CCD", payTo: "P", maxTimeoutSeconds: 60, extra: {} }] })).toString("base64");
  const deps = (): GuardDeps => ({
    registryNetwork: "testnet", concordiumNetwork: "ccd:4221332d34e1694168c2a0c0b3fd0f27", registryAddress: "12802.0",
    registry: async () => { throw new Error("registry down"); }, readAgent: async () => null,
    fetch: (async (url: string) => { calls++; if (String(url).includes("vet402")) throw new Error("ECONNREFUSED 10.0.0.5"); return new Response("", { status: 402, headers: { "PAYMENT-REQUIRED": pr } }); }) as typeof fetch,
  });
  let t = 0;
  const app = express(); app.use(guardPresetRouter({ publicUrl: "https://me.test", deps, now: () => t, log: () => {} }));
  const s = await new Promise<{ url: string; close: () => void }>((ok) => { const h = app.listen(0, () => ok({ url: `http://127.0.0.1:${(h.address() as { port: number }).port}`, close: () => h.close() })); });
  assert.deepEqual((await (await fetch(`${s.url}/guard/presets`)).json()).map((p: { id: string }) => p.id), presets("x").map((p) => p.id));
  assert.equal((await fetch(`${s.url}/guard/check/${encodeURIComponent("http://169.254.169.254")}`)).status, 404);
  const a = await (await fetch(`${s.url}/guard/check/mainsmarker`)).json();
  assert.equal(a.ok, false); // registry down → fail closed
  assert.equal(a.paid, false);
  const before = calls;
  await fetch(`${s.url}/guard/check/mainsmarker`);
  assert.equal(calls, before, "second call within a minute is served from cache");
  t += 61_000;
  await fetch(`${s.url}/guard/check/mainsmarker`);
  assert.ok(calls > before);
  const v = await (await fetch(`${s.url}/guard/check/vet402`)).json();
  assert.equal(v.error, "check_failed");
  assert.doesNotMatch(JSON.stringify(v), /10\.0\.0\.5|ECONNREFUSED/);
  s.close();
});
