import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { RateLimiter, inlineScriptHashes, rateLimit, securityHeaders } from "../src/security.ts";

test("limiter allows N per window, then refuses until the window resets", () => {
  let now = 0;
  const l = new RateLimiter(3, 1000, () => now);
  assert.deepEqual([l.take("a"), l.take("a"), l.take("a"), l.take("a")], [true, true, true, false]);
  assert.equal(l.take("b"), true, "other keys are independent");
  now = 1000;
  assert.equal(l.take("a"), true, "window reset");
});

test("challenge endpoint: site-wide budget holds even when IPs rotate", async () => {
  const app = express();
  app.use(express.json());
  const site = new RateLimiter(2, 60_000);
  app.post(
    "/c",
    rateLimit([
      { limiter: new RateLimiter(100, 60_000), key: (r) => String(r.headers["x-ip"]), what: "per IP" },
      { limiter: site, key: () => "all", what: "site-wide" },
    ]),
    (_q, r) => r.json({ ok: true }),
  );
  const srv = app.listen(0);
  const port = (srv.address() as { port: number }).port;
  const codes = [];
  for (const ipAddr of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) {
    const r = await fetch(`http://127.0.0.1:${port}/c`, { method: "POST", headers: { "x-ip": ipAddr } });
    codes.push(r.status);
    if (r.status === 429) assert.ok(Number(r.headers.get("retry-after")) >= 1);
  }
  srv.close();
  assert.deepEqual(codes, [200, 200, 429]);
});

test("security headers and CSP hashes cover the pages' inline scripts", async () => {
  const pages = ["../public/index.html", "../public/verify.html"].map((p) => new URL(p, import.meta.url).pathname);
  const hashes = inlineScriptHashes(pages);
  assert.equal(hashes.length, 2);
  const styles = inlineScriptHashes(pages, "style");
  assert.equal(styles.length, 2);
  const app = express();
  app.use(securityHeaders(hashes, [], styles));
  app.get("/", (_q, r) => r.send("ok"));
  const srv = app.listen(0);
  const r = await fetch(`http://127.0.0.1:${(srv.address() as { port: number }).port}/`);
  srv.close();
  const csp = r.headers.get("content-security-policy")!;
  assert.match(csp, /script-src 'self' 'sha256-/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.match(csp, /style-src 'self' 'sha256-/);
  assert.equal(r.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(r.headers.get("cross-origin-embedder-policy"), "require-corp");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.match(csp, /frame-ancestors 'self' https:\/\/huggingface.co/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
});

test("only the wallet page allows eval/WebAssembly (the wallet's injected SDK needs it)", async () => {
  const app = express();
  app.use(securityHeaders(["'sha256-x'"], ["/verify"]));
  app.get(["/", "/verify"], (_q, r) => r.send("ok"));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  const [home, verify] = await Promise.all([fetch(base + "/"), fetch(base + "/verify")]);
  srv.close();
  assert.doesNotMatch(home.headers.get("content-security-policy")!, /unsafe-eval/);
  assert.match(verify.headers.get("content-security-policy")!, /script-src 'self' 'sha256-x' 'unsafe-eval' 'wasm-unsafe-eval'/);
});
