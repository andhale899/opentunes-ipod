#!/bin/sh
# Downloads a file and refuses to continue unless its SHA-256 matches.
# Usage: fetch URL SHA256 DEST
set -eu

if [ "$#" -ne 3 ]; then
  echo "usage: fetch URL SHA256 DEST" >&2
  exit 2
fi

url=$1
sha=$2
dest=$3

curl -fsSL --retry 3 --retry-delay 2 -o "$dest" "$url"
echo "$sha  $dest" | sha256sum -c -
