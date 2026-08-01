#!/usr/bin/env bash
# Build the publish image and verify its existing HTTP health contract.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${CANONRY_DOCKER_SMOKE_IMAGE:-canonry:ci}"
container="canonry-smoke-$$"

# shellcheck disable=SC2329 # Invoked by the EXIT trap below.
cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cd "$repo_root"
docker build --file Dockerfile --tag "$image" .
docker run -d --rm --name "$container" -p 127.0.0.1::4100 -e CANONRY_API_KEY=test "$image"

binding="$(docker port "$container" 4100/tcp | head -n 1)"
port="${binding##*:}"
if [[ -z "$port" || ! "$port" =~ ^[0-9]+$ ]]; then
  echo "Could not determine the published health-check port: $binding" >&2
  exit 1
fi

for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$port/health" >/dev/null; then
    exit 0
  fi
  sleep 2
done

docker logs "$container" >&2 || true
echo "Canonry container did not become healthy" >&2
exit 1
