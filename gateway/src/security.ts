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

/** Fixed-window counter (in memory; enough for a single-container deployment). Memory is bounded: past `maxKeys` live keys,
 *  new keys are refused (they get a 429) until old windows expire, and expired keys are swept at most once a second */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  private sweptAt = 0;

  constructor(private limit: number, private windowMs: number, private now: () => number = Date.now, private maxKeys = 50_000) {}

  /** true = allow; false = over the limit */
  take(key: string): boolean {
    const t = this.now();
    const h = this.hits.get(key);
    if (!h || h.resetAt <= t) {
      if (!h && this.hits.size >= this.maxKeys) {
        this.sweep(t);
        if (this.hits.size >= this.maxKeys) return false;
      }
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
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

  get size() {
    return this.hits.size;
  }

  private sweep(t: number) {
    if (t - this.sweptAt < 1000) return;
    this.sweptAt = t;
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}

/** The rate-limit key for a client address: IPv4 as is, IPv6 by its /64 (one household or server usually owns a whole /64) */
export function clientKey(ip: string | undefined): string {
  if (!ip) return "unknown";
  const v4 = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4) return v4[1];
  if (!ip.includes(":")) return ip;
  // Expand "::" and keep the first four groups
  const [head, tail = ""] = ip.toLowerCase().split("%")[0].split("::");
  const h = head ? head.split(":") : [];
  const tl = ip.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = ip.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - tl.length)).fill("0"), ...tl] : h;
  return `${groups.slice(0, 4).map((g) => g || "0").join(":")}::/64`;
}

/** TRUST_PROXY read literally: unset, "0" or "false" = off; a number = that many proxy hops; "true" = trust all (not advised) */
export function trustProxySetting(v: string | undefined): number | boolean | undefined {
  if (v === undefined || v.trim() === "" || v === "0" || /^false$/i.test(v)) return undefined;
  if (/^true$/i.test(v)) return true;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`TRUST_PROXY must be a number of proxy hops, got ${JSON.stringify(v)}`);
  return n;
}

/** This process calling itself (MCP and A2A tools read the gateway's own routes): not a visitor, so not rate-limited per IP */
export function isSelfCall(req: { socket?: { remoteAddress?: string }; headers: Record<string, unknown> }): boolean {
  const a = req.socket?.remoteAddress ?? "";
  return (a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1") && !req.headers["x-forwarded-for"];
}

/** An error message safe to show a visitor: no URLs, hosts, ports or file paths, at most 200 characters */
export function publicMessage(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  return m
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/\b[\w.-]+\.(?:com|software|io|dev|app|net|org|eu|bot|tech|cloud|internal|local)(?::\d+)?\b/gi, "[host]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "[address]")
    .replace(/(?:\/[\w.@-]+){2,}/g, "[path]")
    .slice(0, 200);
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

/** A check's detail for a public page: what was compared stays, but the raw error after "unreachable:" or "could not read …:" does not */
export function scrubDetail(d: string): string {
  return d.replace(/((?:node |registry |service )?unreachable|could not read [^:]{1,60}|no usable answer from [^:]{1,60}): .*$/i, "$1 (details in the server log)");
}
