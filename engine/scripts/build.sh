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

# The image tag defaults to "engine". Set OPENTUNES_ENGINE_TAG to build under another tag, so a
# branch can build without replacing the image another checkout uses:
#   OPENTUNES_ENGINE_TAG=artwork npm run engine:build
tag=${OPENTUNES_ENGINE_TAG:-engine}
docker build -f "$here/Dockerfile" --target engine -t "opentunes-engine:$tag" "$here"

# engine/build holds only generated output, so start clean: no stale files from older builds.
rm -rf "$out"
mkdir -p "$out"
container=$(docker create "opentunes-engine:$tag")
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
docker cp "$container:/out/." "$out/"

echo
echo "Engine written to $out:"
ls -l "$out"
