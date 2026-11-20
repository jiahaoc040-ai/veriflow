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

/** 頁面裡 inline <script>（或 <style>）的 CSP 雜湊（啟動時算一次） */
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
 * walletPaths：需要 Concordium 錢包的頁面（/verify）。錢包用 chrome.scripting.executeScript(world: "MAIN")
 * 把它的 API 注入到頁面裡，那段程式受頁面 CSP 管；它載入 Concordium SDK 時需要 eval 與 WebAssembly，
 * 所以只有這些頁面加上 'unsafe-eval' 'wasm-unsafe-eval'。script 來源仍然只限本站 + 雜湊白名單。
 */
export function securityHeaders(scriptHashes: string[], walletPaths: string[] = [], styleHashes: string[] = []) {
  const build = (wallet: boolean) => [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.join(" ")}${wallet ? " 'unsafe-eval' 'wasm-unsafe-eval'" : ""}`,
    // 樣式也只允許頁面裡我們自己的 <style>（雜湊白名單），不允許任意 inline 樣式
    `style-src 'self' ${styleHashes.join(" ")}`.trim(),
    "img-src 'self' data:",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
    // Hugging Face 的 Space 頁面用 iframe 嵌入；其他網站不准嵌入（防點擊劫持）
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
    // COEP 會限制跨來源資源；錢包頁不加，避免影響錢包的注入與彈出視窗
    if (!walletPaths.includes(req.path)) res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    // 全部都是動態內容（訊號、驗證狀態、鏈上資料），不讓瀏覽器或中間代理快取
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  };
}
