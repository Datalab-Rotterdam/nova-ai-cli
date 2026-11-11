#!/bin/sh
# Tests scripts/install.sh against a folder of release files, on the machine it runs on.
# Usage: sh scripts/smoke-install.sh <folder with archives and SHA256SUMS> <version>
set -eu
release=$(cd "$1" && pwd)
version=$2
here=$(cd "$(dirname "$0")" && pwd)
sandbox=$(mktemp -d)
trap 'rm -rf "$sandbox"' EXIT

NOVA_AI_DOWNLOAD_URL="file://$release" sh "$here/install.sh" --version "$version" --dir "$sandbox/bin"
[ "$(NOVA_NO_UPDATE_CHECK=1 "$sandbox/bin/nova-ai" --version)" = "nova-ai $version" ]
echo "ok    installs and runs"

# Reinstalling replaces it; a running copy or an earlier install is no obstacle.
NOVA_AI_DOWNLOAD_URL="file://$release" sh "$here/install.sh" --version "$version" --dir "$sandbox/bin" >/dev/null
[ "$(ls -A "$sandbox/bin")" = "nova-ai" ]
echo "ok    reinstalls, leaving nothing behind"

if [ "$(uname -s)" = Darwin ]; then
  if xattr "$sandbox/bin/nova-ai" | grep -q com.apple.quarantine; then
    echo "FAIL  quarantined, macOS would block it"
    exit 1
  fi
  echo "ok    not quarantined"
fi

# A bad checksum must install nothing.
mkdir "$sandbox/bad"
cp "$release"/* "$sandbox/bad/"
awk '{ print "0000000000000000000000000000000000000000000000000000000000000000  " $2 }' "$release/SHA256SUMS" >"$sandbox/bad/SHA256SUMS"
if NOVA_AI_DOWNLOAD_URL="file://$sandbox/bad" sh "$here/install.sh" --version "$version" --dir "$sandbox/bad-bin" 2>/dev/null; then
  echo "FAIL  installed despite a bad checksum"
  exit 1
fi
[ ! -e "$sandbox/bad-bin/nova-ai" ]
echo "ok    a bad checksum installs nothing"
