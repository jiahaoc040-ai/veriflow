# Concordium x402 Seller Check (GitHub Action)

Before your agent pays an x402 seller, check that seller on Concordium, in CI: it must be an Active agent in the CIS-8004 Agent Registry, pass the official badge check, serve the Agent Card whose SHA-256 is pinned on-chain, and ask to be paid at its own on-chain `agentWallet` (or, on Base, a key bound to its owner in CIS-8). No wallet; nothing is paid. It runs [`concordium-x402-guard`](https://www.npmjs.com/package/concordium-x402-guard), the same checks the package runs inside a paying agent.

```yaml
- uses: jiahaoc040-ai/concordium-x402-seller-check@v1.0.0
  with:
    url: https://mainsmarker.sites.tab.bot/x402/review
    method: POST
    body: '{"question":"Explain why the sky appears blue during the day.","answer":"Rayleigh scattering of sunlight by air molecules.","marks":10}'
```

On mainnet, checking a seller's Base payout:

```yaml
- uses: jiahaoc040-ai/concordium-x402-seller-check@v1.0.0
  with:
    url: https://x402-doctor.fizzl.eu/api/v1/preflight
    network: mainnet
    pay-network: eip155:8453
```

The step fails when the guard would refuse to pay (`fail-on-refusal: "false"` to only report). Outputs: `ok`, `agent`, `summary`; the job summary lists every check. Uses: a nightly job that refuses to deploy an agent whose paid dependencies stopped passing, or a seller checking its own listing after each release.

Part of [VeriFlow](https://github.com/jiahaoc040-ai/veriflow). MIT.
