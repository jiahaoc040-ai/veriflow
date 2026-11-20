# Security policy

VeriFlow runs on Concordium **testnet** only; no real funds are at risk. Even so, we want to hear about anything that could let someone:

- fake or edit the track record (commitments, reveal, scoring),
- buy without passing the zero-knowledge eligibility check, or reuse someone else's proof,
- make a buyer agent pay an impersonator, or pay more than its cap,
- spend the operator's CCD (sponsored fees, anchors) at scale, or
- read or exfiltrate keys or personal data.

## Reporting

Please use GitHub's **private vulnerability reporting** for this repository (Security tab → "Report a vulnerability"). Do not open a public issue for an unfixed problem. Include the steps to reproduce and, where relevant, the testnet transaction hashes.

We aim to reply within 72 hours, and we will credit reporters in the fix commit unless you prefer otherwise.

## Scope

- In scope: everything in this repository and the deployment at <https://veriflow-yrhp.onrender.com>.
- Out of scope: Concordium itself, the Agent Registry service, `@x402/*` packages, and the hosting providers. Please report issues there to their maintainers.

How each attack is defended today: [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
