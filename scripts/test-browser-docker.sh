#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
test_image="afterhours-browser-test:run-$$"
game_container="afterhours-browser-game-$$"
browser_id=""
cleanup() {
  docker rm -f "$game_container" >/dev/null 2>&1 || true
  if [[ -n "$browser_id" ]]; then docker rm -f "$browser_id" >/dev/null; fi
  docker image rm "$test_image" >/dev/null 2>&1 || true
}
trap cleanup EXIT
docker info >/dev/null
docker build -t "$test_image" .
browser_id=$(docker run -d --rm -p 127.0.0.1::9222 \
  chromedp/headless-shell@sha256:f70908c8020555a3bf89a070140913b443a03ead28c1a66563c3912a3b32b08d)
browser_port=$(docker port "$browser_id" 9222/tcp)
bridge_gateway=$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')
for attempt in {1..30}; do
  if curl -fsS "http://$browser_port/json/version" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://$browser_port/json/version" >/dev/null
BROWSER_DOCKER_IMAGE="$test_image" \
  BROWSER_GAME_CONTAINER="$game_container" \
  CHROMIUM_CDP_URL="http://$browser_port" \
  BROWSER_GAME_URL="http://$bridge_gateway:4175" \
  bun run test:browser "$@"
