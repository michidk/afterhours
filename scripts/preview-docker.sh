#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
revision="${1:?Pass the full commit hash to deploy}"
container="${2:?Pass the managed preview container name}"
: "${PORT:?Managed preview port is required}"
: "${PUBLIC_ORIGIN:?Public preview origin is required}"
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a full commit hash' >&2; exit 1; }
image="afterhours-preview:$revision"
if ! docker image inspect "$image" >/dev/null 2>&1; then
  git archive "$revision" | docker build -t "$image" -
fi
docker rm -f "$container" >/dev/null 2>&1 || true
exec docker run --rm --name "$container" \
  -p "127.0.0.1:$PORT:5173" \
  -e "ALLOW_DEBUG=${ALLOW_DEBUG:-0}" \
  -e "PUBLIC_ORIGIN=$PUBLIC_ORIGIN" "$image"
