#!/usr/bin/env bash
# Builds crates/physics to wasm for the browser (crates/physics/pkg) and, with --node,
# for Node (pkg-node) so scripts/physics-parity.mjs can compare it with the native build.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
cargo build --release --target wasm32-unknown-unknown --features wasm -p afterhours-physics
TARGET=$(cargo metadata --format-version 1 --no-deps | sed -n 's/.*"target_directory":"\([^"]*\)".*/\1/p')
WASM=$TARGET/wasm32-unknown-unknown/release/afterhours_physics.wasm
wasm-bindgen --target web --out-dir crates/physics/pkg "$WASM"
if [[ "${1:-}" == "--node" ]]; then
  wasm-bindgen --target nodejs --out-dir crates/physics/pkg-node "$WASM"
  # The root package.json is "type": "module"; the nodejs target emits CommonJS.
  echo '{"type":"commonjs"}' > crates/physics/pkg-node/package.json
fi
