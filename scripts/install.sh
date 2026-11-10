#!/bin/sh
# Installs the standalone nova-ai binary from its GitHub release, for macOS and Linux.
#
#   curl -fsSL https://datalabrotterdam.nl/nova-ai/install.sh | bash
#   curl -fsSL https://datalabrotterdam.nl/nova-ai/install.sh | bash -s -- --channel alpha
#
# Run it again to update: it finds the nova-ai already on your PATH, says what changes, and
# replaces that copy in place (or does nothing when it is current).
#
# Options: --channel <latest|alpha> (default latest), --version <v>, --dir <folder>, --force.
# New installs go to ~/.local/bin, or NOVA_AI_INSTALL_DIR. Downloading with curl keeps the file free of
# macOS quarantine. It installs into a folder you own, so no sudo, and /update can replace it.
#
# Everything runs from main at the end, so a download cut off halfway executes nothing.
set -eu

REPO_URL="https://github.com/Datalab-Rotterdam/nova-ai-cli"
RELEASES_API="https://api.github.com/repos/Datalab-Rotterdam/nova-ai-cli/releases?per_page=100"
TAG_PREFIX="@datalabrotterdam/nova-ai-cli@"
work=""

say() { printf '%s\n' "$*"; }
die() {
  printf 'nova-ai install: %s\n' "$*" >&2
  exit 1
}

download() { curl -fsSL --proto '=https,file' --tlsv1.2 "$1"; }

detect_target() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin)
      os=darwin
      # A shell under Rosetta reports x86_64 on an Apple Silicon Mac.
      if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then arch=arm64; fi
      ;;
    Linux)
      os=linux
      if ldd --version 2>&1 | grep -qi musl; then
        die "musl Linux (such as Alpine) has no binary. See $REPO_URL/releases"
      fi
      ;;
    *) die "no binary for $os. On Windows, download the zip from $REPO_URL/releases" ;;
  esac
  case "$arch" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) die "no binary for $arch." ;;
  esac
  printf '%s-%s' "$os" "$arch"
}

# The newest release of this package: "latest" skips prereleases, any other channel (alpha)
# takes the newest of all. Only curl and awk, so no Node or npm is needed.
find_version() {
  list=$(download "$RELEASES_API") || die "could not reach GitHub to find the $1 version."
  found=$(printf '%s\n' "$list" | awk -v prefix="$TAG_PREFIX" -v channel="$1" '
    /"tag_name":/ { tag = $0; sub(/.*"tag_name": *"/, "", tag); sub(/".*/, "", tag) }
    /"prerelease":/ {
      pre = ($0 ~ /true/)
      if (index(tag, prefix) == 1 && (channel != "latest" || !pre)) { print substr(tag, length(prefix) + 1); exit }
    }')
  [ -n "$found" ] || die "no $1 release found. Releases: $REPO_URL/releases"
  printf '%s' "$found"
}

# Prints the folder of a nova-ai this script can replace: on PATH, writable, a real binary and
# not an npm install (that one is updated with npm).
find_existing() {
  found=$(command -v nova-ai 2>/dev/null) || return 0
  case "$(readlink "$found" 2>/dev/null || true)$found" in *node_modules*) return 0 ;; esac
  [ -f "$found" ] && [ ! -L "$found" ] && [ -w "$(dirname "$found")" ] || return 0
  dirname "$found"
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    die "need sha256sum or shasum to check the download."
  fi
}

main() {
  channel=latest
  version=${NOVA_AI_VERSION:-}
  dir=${NOVA_AI_INSTALL_DIR:-}
  force=0
  while [ $# -gt 0 ]; do
    if [ "$1" = --force ]; then
      force=1
      shift
      continue
    fi
    [ $# -ge 2 ] || die "$1 needs a value."
    case "$1" in
      --channel) channel=$2 ;;
      --version) version=$2 ;;
      --dir) dir=$2 ;;
      *) die "unknown option $1." ;;
    esac
    shift 2
  done
  case "$channel$version" in
    *[!0-9A-Za-z.+-]*) die "invalid channel or version." ;;
  esac
  command -v curl >/dev/null 2>&1 || die "needs curl."
  command -v tar >/dev/null 2>&1 || die "needs tar."

  target=$(detect_target)
  [ -n "$version" ] || version=$(find_version "$channel")

  existing=$(find_existing)
  [ -n "$dir" ] || dir=${existing:-$HOME/.local/bin}
  current=""
  if [ -x "$dir/nova-ai" ]; then
    current=$(NOVA_NO_UPDATE_CHECK=1 "$dir/nova-ai" --version 2>/dev/null | sed -n 's/^nova-ai //p') || current=""
  fi
  if [ -n "$current" ] && [ "$current" = "$version" ] && [ "$force" = 0 ]; then
    say "nova-ai $version is already installed at $dir/nova-ai. Nothing to do (--force reinstalls)."
    exit 0
  fi
  if [ -n "$current" ]; then
    say "Updating nova-ai $current -> $version at $dir/nova-ai"
  elif [ -n "$existing" ] && [ "$existing" != "$dir" ]; then
    say "Note: another nova-ai is on your PATH in $existing; this one goes to $dir."
  fi
  asset="nova-ai-$target.tar.gz"
  # NOVA_AI_DOWNLOAD_URL replaces the release, for scripts/smoke-install.sh.
  base=${NOVA_AI_DOWNLOAD_URL:-$REPO_URL/releases/download/%40datalabrotterdam%2Fnova-ai-cli%40$version}

  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT

  say "Downloading nova-ai $version for $target..."
  if ! download "$base/SHA256SUMS" >"$work/SHA256SUMS" || ! download "$base/$asset" >"$work/$asset"; then
    die "nova-ai $version has no binaries. Releases: $REPO_URL/releases"
  fi

  expected=$(awk -v file="$asset" '$2 == file { print $1 }' "$work/SHA256SUMS")
  [ -n "$expected" ] || die "$asset is not listed in SHA256SUMS."
  [ "$(sha256 "$work/$asset")" = "$expected" ] || die "$asset does not match its checksum. Nothing was installed."

  mkdir -p "$work/unpacked"
  tar -xzf "$work/$asset" -C "$work/unpacked" nova-ai
  mkdir -p "$dir"
  # Beside the target, so the final rename is atomic and a running nova-ai is not disturbed.
  fresh="$dir/.nova-ai-install.$$"
  trap 'rm -rf "$work" "$fresh"' EXIT
  cp "$work/unpacked/nova-ai" "$fresh"
  chmod 755 "$fresh"
  reported=$(NOVA_NO_UPDATE_CHECK=1 "$fresh" --version 2>&1) || die "the binary does not run here: $reported"
  [ "$reported" = "nova-ai $version" ] || die "expected nova-ai $version, the binary reported: $reported"
  mv -f "$fresh" "$dir/nova-ai"

  if [ -n "$current" ]; then verb=Updated; else verb=Installed; fi
  say "$verb nova-ai $version at $dir/nova-ai"
  case ":$PATH:" in
    *":$dir:"*) say "Next: nova-ai login" ;;
    *)
      say "$dir is not on your PATH. Add this to your shell profile (~/.zshrc or ~/.bashrc):"
      say "  export PATH=\"$dir:\$PATH\""
      say "Then open a new terminal and run: nova-ai login"
      ;;
  esac
}

main "$@"
