/**
 * Protections for public deployment
 * ----------------
 * 1. Rate limits: every /eligibility/challenge sends an on-chain transaction (paid in CCD by the anchoring account);
 *    unlimited, anyone could drain that account in a loop. Besides per-IP and per-account limits
 *    there is a site-wide hourly cap that switching IPs cannot get around.
 * 2. Security headers: CSP (only our own inline scripts on the page, by SHA-256 allow-list),
 *    nosniff, Referrer-Policy, framing only by Hugging Face, HSTS over HTTPS.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { NextFunction, Request, Response } from "express";

/** Fixed-window counter (in memory; enough for a single-container deployment) */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private limit: number, private windowMs: number, private now: () => number = Date.now) {}

  /** true = allow; false = over the limit */
  take(key: string): boolean {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || h.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      if (this.hits.size > 10_000) this.sweep(t);
      return true;
    }
    if (h.count >= this.limit) return false;
    h.count++;
    return true;
  }

  retryAfterSec(key: string): number {
    const h = this.hits.get(key);
    return h ? Math.max(1, Math.ceil((h.resetAt - this.now()) / 1000)) : 1;
  }

  private sweep(t: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}

type KeyFn = (req: Request) => string | undefined;

/** Check several limits together (e.g. per IP, per account, site-wide) */
export function rateLimit(rules: { limiter: RateLimiter; key: KeyFn; what: string }[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    for (const r of rules) {
      const k = r.key(req);
      if (k === undefined) continue;
      if (!r.limiter.take(k)) {
        res.setHeader("Retry-After", String(r.limiter.retryAfterSec(k)));
        return res.status(429).json({ error: `rate_limited: too many requests (${r.what}), try again later` });
      }
    }
    next();
  };
}

/** CSP hashes of the page's inline <script> (or <style>) blocks (computed once at startup) */
export function inlineScriptHashes(htmlFiles: string[], tag: "script" | "style" = "script"): string[] {
  const out = new Set<string>();
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "g");
  for (const f of htmlFiles) {
    const html = readFileSync(f, "utf8");
    for (const m of html.matchAll(re)) {
      out.add(`'sha256-${createHash("sha256").update(m[1], "utf8").digest("base64")}'`);
    }
  }
  return [...out];
}

/**
 * walletPaths: pages that need the Concordium wallet (/verify). The wallet injects its API into the page with
 * chrome.scripting.executeScript(world: "MAIN"), so that code is governed by the page's CSP; loading the Concordium SDK needs eval and WebAssembly,
 * so only these pages get 'unsafe-eval' 'wasm-unsafe-eval'. Script sources are still limited to this site + the hash allow-list.
 */
export function securityHeaders(scriptHashes: string[], walletPaths: string[] = [], styleHashes: string[] = []) {
  const build = (wallet: boolean) => [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.join(" ")}${wallet ? " 'unsafe-eval' 'wasm-unsafe-eval'" : ""}`,
    // Styles too: only our own <style> blocks on the page (hash allow-list), no arbitrary inline styles
    `style-src 'self' ${styleHashes.join(" ")}`.trim(),
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
    // The Hugging Face Space page embeds us in an iframe; no other site may (clickjacking protection)
    "frame-ancestors 'self' https://huggingface.co",
  ].join("; ");
  const strict = build(false);
  const wallet = build(true);
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Content-Security-Policy", walletPaths.includes(req.path) ? wallet : strict);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    // COEP restricts cross-origin resources; not on wallet pages, so wallet injection and pop-ups keep working
    if (!walletPaths.includes(req.path)) res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    // Everything is dynamic (signals, verification state, chain data), so browsers and proxies must not cache it
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  };
}
