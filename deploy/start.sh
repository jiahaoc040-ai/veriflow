#!/bin/sh
# Starts the three VeriFlow processes. Secrets come from the platform:
#   FACILITATOR_KEY_JSON  contents of the sponsor/anchor account's .export file (testnet)
#   SELLER_ADDRESS, GATEWAY_SECRET, DATABASE_URL (Postgres), PUBLIC_URL
#   optional: REGISTRY_CONTRACT, RESTRICTED_COUNTRIES, PRICE_MICROCCD
set -eu

: "${FACILITATOR_KEY_JSON:?set FACILITATOR_KEY_JSON (testnet .export contents) as a secret}"
: "${SELLER_ADDRESS:?set SELLER_ADDRESS}"
: "${GATEWAY_SECRET:?set GATEWAY_SECRET}"
: "${DATABASE_URL:?set DATABASE_URL (Postgres) so data survives restarts}"

umask 077
printf '%s' "$FACILITATOR_KEY_JSON" > /app/gateway/keys/facilitator.export
export FACILITATOR_KEY_FILE=/app/gateway/keys/facilitator.export
export GATEWAY_PORT="${PORT:-7860}"

cd /app
uvicorn veriflow.api:app --host 127.0.0.1 --port 8000 --workers 1 &

# wait for the API before opening the public port
i=0; until python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/health')" 2>/dev/null; do
  i=$((i+1)); [ $i -gt 60 ] && echo "API did not start" && exit 1; sleep 1; done

# facilitator runs inside the gateway process (512 MB hosts), reachable only on localhost
export EMBED_FACILITATOR=1 FACILITATOR_HOST=127.0.0.1
cd gateway && exec node --import tsx src/gateway.ts
