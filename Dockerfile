# VeriFlow: Python signal API + x402 facilitator + gateway in one container.
# Works on Hugging Face Spaces (Docker, port 7860) and Render (PORT env).
FROM node:26-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip python3-venv ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt
ENV PATH="/opt/venv/bin:$PATH"

COPY gateway/package.json gateway/package-lock.json gateway/
RUN cd gateway && npm ci --omit=optional

COPY . .

# Hugging Face runs containers as uid 1000; keys are written at start-up from secrets
RUN mkdir -p /app/gateway/keys /app/gateway/data && chown -R 1000:1000 /app
USER 1000

ENV PORT=7860 \
    API_URL=http://127.0.0.1:8000 \
    FACILITATOR_URL=http://127.0.0.1:4021 \
    BINANCE_PUBLIC_API=https://data-api.binance.vision/api/v3 \
    PYTHONUNBUFFERED=1 \
    TRUST_PROXY=1 \
    DAILY_SIGNALS=on

EXPOSE 7860
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "deploy/start.sh"]
