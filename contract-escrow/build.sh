#!/usr/bin/env sh
# Builds the escrow module and the registry test double the chain tests run against
set -e
cd "$(dirname "$0")"
mkdir -p concordium-out mock-registry/concordium-out
cargo concordium build --schema-embed --out concordium-out/module.wasm.v1
cargo concordium build --schema-json-out concordium-out/
(cd mock-registry && cargo concordium build --out concordium-out/mock.wasm.v1)
sha256sum concordium-out/module.wasm.v1
