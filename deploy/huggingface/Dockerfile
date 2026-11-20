# Hugging Face Space wrapper: builds VeriFlow straight from the public GitHub repo.
# To deploy a newer commit, use "Factory rebuild" in the Space settings.
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends git python3 python3-pip python3-venv ca-certificates tini \
    && rm -rf /var/lib/apt/lists/*

ARG REPO=https://github.com/jiahaoc040-ai/veriflow
ARG REF=main
RUN git clone --depth 1 --branch "$REF" "$REPO" /app

WORKDIR /app
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt
ENV PATH="/opt/venv/bin:$PATH"
RUN cd gateway && npm ci --omit=optional

RUN mkdir -p /app/gateway/keys /app/gateway/data && chown -R 1000:1000 /app
USER 1000

ENV PORT=7860 \
    API_URL=http://127.0.0.1:8000 \
    FACILITATOR_URL=http://127.0.0.1:4021 \
    BINANCE_PUBLIC_API=https://data-api.binance.vision/api/v3 \
    PYTHONUNBUFFERED=1 \
    TRUST_PROXY=1

EXPOSE 7860
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "deploy/start.sh"]
