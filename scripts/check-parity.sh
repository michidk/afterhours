#!/usr/bin/env bash
# The browser predicts with the wasm build of crates/physics and the server runs it natively; a
# scripted run must give the same hash on both, or prediction drifts from the server.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
scripts/build-physics.sh --node
native=$(cargo run -q --release --example parity -p afterhours-physics)
wasm=$(node scripts/physics-parity.mjs)
echo "native: $native"
echo "wasm:   $wasm"
[[ "$native" == "$wasm" ]] || { echo "physics parity broken: native and wasm differ" >&2; exit 1; }
