/**
 * The three eligibility endpoints, framework-free: each takes the parsed request and returns { status, body }.
 * Wire them into Express, Hono or anything else (README). Add rate limits in front of `challenge`: each call pays for an anchor.
 * Errors are reduced to the message text, with URLs, hosts and addresses removed.
 */
import { AccountAddress } from "@concordium/web-sdk";
import type { EligibilityService } from "./eligibility.js";

export type HttpResult = { status: number; body: Record<string, unknown> };

const clean = (e: unknown) =>
  (e instanceof Error ? e.message : String(e))
    .replace(/https?:\/\/\S+/g, "[url]")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, "[address]")
    .slice(0, 200);

export function eligibilityHandlers(service: EligibilityService) {
  return {
    /** POST { account } → a verification request for the wallet, anchored on-chain */
    async challenge(body: unknown): Promise<HttpResult> {
      const account = String((body as { account?: unknown } | undefined)?.account ?? "");
      try { AccountAddress.fromBase58(account); } catch { return { status: 400, body: { error: "account must be a Concordium account address" } }; }
      try {
        const r = await service.challenge(account);
        return { status: 200, body: r as unknown as Record<string, unknown> };
      } catch (e) {
        return { status: 400, body: { error: clean(e) } };
      }
    },
    /** POST { id, presentation } → the wallet's proof checked and, if it holds, the account allow-listed */
    async verify(body: unknown): Promise<HttpResult> {
      const { id, presentation } = (body ?? {}) as { id?: unknown; presentation?: unknown };
      try {
        const json = typeof presentation === "string" ? presentation : JSON.stringify(presentation);
        const rec = await service.verify(String(id), json);
        const { presentationJson: _p, requestJson: _r, credId: _c, challengeId: _i, ...out } = rec;
        return { status: 200, body: { eligible: true, ...out } };
      } catch (e) {
        return { status: 403, body: { eligible: false, error: clean(e) } };
      }
    },
    /** GET → whether the account has a current proof (never the credential id or the proof itself) */
    status(account: string): HttpResult {
      const rec = service.status(account);
      const { credId: _c, presentationJson: _p, requestJson: _r, challengeId: _i, ...pub } = rec ?? ({} as Record<string, unknown>);
      return { status: 200, body: { eligible: !!rec, ...pub, policyId: rec?.policy, policy: service.describe() } };
    },
  };
}
