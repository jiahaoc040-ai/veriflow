/**
 * 公開部署前的防護
 * ----------------
 * 1. 速率限制：/eligibility/challenge 每次都會送一筆上鏈交易（花上鏈帳號的 CCD），
 *    不限制的話任何人都能用迴圈把帳號的錢燒光。除了每個 IP、每個帳號的上限，
 *    還有一個「全站每小時上限」，換 IP 也繞不過去。
 * 2. 安全標頭：CSP（只允許頁面裡我們自己的 inline script，用 SHA-256 白名單）、
 *    nosniff、Referrer-Policy、只允許 Hugging Face 嵌入、HTTPS 時加 HSTS。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { NextFunction, Request, Response } from "express";

/** 固定視窗計數器（記憶體內；單一容器部署夠用） */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(private limit: number, private windowMs: number, private now: () => number = Date.now) {}

  /** 回傳 true = 放行；false = 超過上限 */
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

/** 多個限制同時檢查（例如：每 IP、每帳號、全站） */
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

/** 頁面裡 inline <script> 的 CSP 雜湊（啟動時算一次） */
export function inlineScriptHashes(htmlFiles: string[]): string[] {
  const out = new Set<string>();
  for (const f of htmlFiles) {
    const html = readFileSync(f, "utf8");
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
      out.add(`'sha256-${createHash("sha256").update(m[1], "utf8").digest("base64")}'`);
    }
  }
  return [...out];
}

export function securityHeaders(scriptHashes: string[]) {
  const csp = [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
    // Hugging Face 的 Space 頁面用 iframe 嵌入；其他網站不准嵌入（防點擊劫持）
    "frame-ancestors 'self' https://huggingface.co",
  ].join("; ");
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  };
}
