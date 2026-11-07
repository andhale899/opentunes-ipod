#!/bin/sh
# Builds the engine in Docker and copies the result to engine/build/.
#
#   npm run engine:build
#
# Needs Docker running. The first build compiles every dependency from source and takes a
# few minutes. Later builds reuse Docker's layer cache.
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
out="$here/build"

if ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop and try again." >&2
  exit 1
fi

docker build -f "$here/Dockerfile" --target engine -t opentunes-engine:engine "$here"

mkdir -p "$out"
container=$(docker create opentunes-engine:engine)
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
docker cp "$container:/out/." "$out/"

echo
echo "Engine written to $out:"
ls -l "$out"
