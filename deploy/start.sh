#!/bin/sh
# Starts the three VeriFlow processes. Secrets come from the platform:
#   FACILITATOR_KEY_JSON  contents of the sponsor/anchor account's .export file (testnet)
#   SELLER_ADDRESS, GATEWAY_SECRET, DATABASE_URL (Postgres), PUBLIC_URL
#   optional: REGISTRY_CONTRACT, RESTRICTED_COUNTRIES, PRICE_MICROCCD
#   optional: DEMO_BUYER_KEY_JSON  contents of buyer agent #1478's .export file: turns on the site's "watch an agent buy" button
set -eu

: "${FACILITATOR_KEY_JSON:?set FACILITATOR_KEY_JSON (testnet .export contents) as a secret}"
: "${SELLER_ADDRESS:?set SELLER_ADDRESS}"
: "${GATEWAY_SECRET:?set GATEWAY_SECRET}"
: "${DATABASE_URL:?set DATABASE_URL (Postgres) so data survives restarts}"

umask 077
printf '%s' "$FACILITATOR_KEY_JSON" > /app/gateway/keys/facilitator.export
export FACILITATOR_KEY_FILE=/app/gateway/keys/facilitator.export
if [ -n "${DEMO_BUYER_KEY_JSON:-}" ]; then
  printf '%s' "$DEMO_BUYER_KEY_JSON" > /app/gateway/keys/demo-buyer.export
  export DEMO_BUYER_KEY_FILE=/app/gateway/keys/demo-buyer.export
  unset DEMO_BUYER_KEY_JSON
fi
export GATEWAY_PORT="${PORT:-7860}"

cd /app
uvicorn veriflow.api:app --host 127.0.0.1 --port 8000 --workers 1 &

# wait for the API before opening the public port
i=0; until python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/health')" 2>/dev/null; do
  i=$((i+1)); [ $i -gt 60 ] && echo "API did not start" && exit 1; sleep 1; done

# Settlement: Concordium's hosted testnet facilitator when FACILITATOR_URL and FACILITATOR_API_KEY are set,
# otherwise our own facilitator inside the gateway process (512 MB hosts), reachable only on localhost
if [ -n "${FACILITATOR_API_KEY:-}" ] && [ -n "${FACILITATOR_URL:-}" ]; then
  echo "settlement via ${FACILITATOR_URL}"
else
  export EMBED_FACILITATOR=1 FACILITATOR_HOST=127.0.0.1
  unset FACILITATOR_URL
fi
cd gateway && exec node --import tsx src/gateway.ts
