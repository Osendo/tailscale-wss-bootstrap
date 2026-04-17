#!/usr/bin/env bash
#
# Run real integration tests against a local Headscale control server.
# No external auth key required — everything is self-contained.
#
# Usage:
#   bash test/run-real.sh
#
set -euo pipefail
cd "$(dirname "$0")/.."

NETWORK="ts-ci-$$"
HEADSCALE_IMAGE="headscale/headscale:latest"

cleanup() {
  echo "Cleaning up..."
  docker rm -f headscale-ci 2>/dev/null || true
  docker network rm "$NETWORK" 2>/dev/null || true
}
trap cleanup EXIT

# ── Network ──────────────────────────────────────────────────────────────────
docker network create "$NETWORK"

# ── Headscale ────────────────────────────────────────────────────────────────
docker run -d --name headscale-ci --network "$NETWORK" \
  -v "$PWD/test/headscale.yaml:/etc/headscale/config.yaml:ro" \
  "$HEADSCALE_IMAGE" serve

echo "Waiting for headscale..."
for i in $(seq 1 30); do
  docker exec headscale-ci headscale users list &>/dev/null && break
  sleep 1
  if [ "$i" -eq 30 ]; then
    echo "ERROR: headscale did not become ready"
    docker logs headscale-ci
    exit 1
  fi
done
echo "Headscale is ready."

# ── Create user + pre-auth key ───────────────────────────────────────────────
docker exec headscale-ci headscale users create ci 2>/dev/null || true
USER_ID=$(docker exec headscale-ci headscale users list -o json | jq -r '.[] | select(.name=="ci") | .id')
AUTH_KEY=$(docker exec headscale-ci headscale preauthkeys create --user "$USER_ID" --reusable --expiration 1h 2>&1 | tail -1 | tr -d '[:space:]')

if [ -z "$AUTH_KEY" ]; then
  echo "ERROR: failed to create pre-auth key"
  docker exec headscale-ci headscale preauthkeys list --user ci
  exit 1
fi
echo "Auth key: ${AUTH_KEY:0:12}..."

# ── Build + run tests ────────────────────────────────────────────────────────
docker build -f Dockerfile.test -t tailer-test .

docker run --rm --network "$NETWORK" \
  --cap-add=NET_ADMIN --cap-add=NET_RAW \
  --device=/dev/net/tun \
  -e TAILSCALE_AUTH_KEY="$AUTH_KEY" \
  -e TS_LOGIN_SERVER=http://headscale-ci:8080 \
  tailer-test

echo "All real tests passed!"
