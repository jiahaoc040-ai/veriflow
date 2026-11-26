/** Same review fixes as the npm package, in the gateway's copy */
import { test } from "node:test";
import assert from "node:assert/strict";
import { boundAs, transient, guardDeps } from "../src/guard-deps.ts";
import { cardUrlAllowed, sameAccountSafe } from "../src/counterparty.ts";
import { checkSellerFor, type GuardDeps } from "../src/guard.ts";

const OWNER = "3p6DTnSwRwczJL5JxmB89jveUFJq6x6npc1azREG7bzXvQiP6c";
const WALLET = "4J2SFgeVrLHVqPkb3dczpYKP99wFMm7FDFp3fEPwXMff3ieLi2";
const OTHER = "3ZXiUAM8TYs1c9RfocVN6fude9vUnETLVGg3Tdk5vgSQhFi63D";

test("gateway guard: payment network pinned to this node's network and its one EVM chain", async () => {
  const d = guardDeps();
  assert.deepEqual(d.evmNetworks, ["eip155:84532"]);
  const stub: GuardDeps = { ...d, registry: async () => { throw new Error("must not be asked"); } };
  const v = await checkSellerFor({ origin: "https://x.test", req: { network: "ccd:9dd9ca4d19e9393877d2c44b70f89acb", payTo: WALLET, amount: "1", asset: "CCD" } }, stub, { reputation: "off" });
  assert.equal(v.ok, false);
  const e = await checkSellerFor({ origin: "https://x.test", req: { network: "eip155:8453", payTo: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf", amount: "1", asset: "USDC" } }, stub, { reputation: "off" });
  assert.equal(e.ok, false);
});

test("gateway guard: card URLs, aliases, binding owner, transient errors", () => {
  assert.throws(() => cardUrlAllowed("http://127.0.0.1:6379/"));
  assert.throws(() => cardUrlAllowed("https://169.254.169.254/latest"));
  cardUrlAllowed("https://seller.test/card");
  assert.equal(sameAccountSafe("bad", WALLET), false);
  assert.equal(boundAs(WALLET, { owner: OWNER, wallet: WALLET }), "agentWallet");
  assert.equal(boundAs(OTHER, { owner: OWNER, wallet: WALLET }), undefined);
  assert.equal(transient(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ECONNREFUSED" }) })), true);
  assert.equal(transient(new Error("agent_by_token_address: HTTP 503")), true);
  assert.equal(transient(new Error("no agent 500 found")), false);
});
