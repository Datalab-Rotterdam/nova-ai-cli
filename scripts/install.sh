#!/bin/sh
# Installs the standalone nova-ai binary from its GitHub release, for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/Datalab-Rotterdam/nova-ai-cli/alpha/scripts/install.sh | sh -s -- --channel alpha
#
# Options: --channel <npm dist-tag> (default latest), --version <v>, --dir <folder>
# (default ~/.local/bin, or NOVA_AI_INSTALL_DIR). Downloading with curl keeps the file free of
# macOS quarantine. It installs into a folder you own, so no sudo, and /update can replace it.
#
# Everything runs from main at the end, so a download cut off halfway executes nothing.
set -eu

REPO_URL="https://github.com/Datalab-Rotterdam/nova-ai-cli"
DIST_TAGS_URL="https://registry.npmjs.org/-/package/@datalabrotterdam%2Fnova-ai-cli/dist-tags"
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
        die "musl Linux (such as Alpine) has no binary. Use: npm install -g @datalabrotterdam/nova-ai-cli"
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

find_version() {
  tags=$(download "$DIST_TAGS_URL") || die "could not reach npm to find the $1 version."
  found=$(printf '%s' "$tags" | tr ',{}' '\n' | sed -n "s/^\"$1\":\"\(.*\)\"$/\1/p")
  [ -n "$found" ] || die "no channel named $1."
  printf '%s' "$found"
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
  dir=${NOVA_AI_INSTALL_DIR:-$HOME/.local/bin}
  while [ $# -gt 0 ]; do
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
  asset="nova-ai-$target.tar.gz"
  # NOVA_AI_DOWNLOAD_URL replaces the release, for scripts/smoke-install.sh.
  base=${NOVA_AI_DOWNLOAD_URL:-$REPO_URL/releases/download/%40datalabrotterdam%2Fnova-ai-cli%40$version}

  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT

  say "Downloading nova-ai $version for $target..."
  if ! download "$base/SHA256SUMS" >"$work/SHA256SUMS" || ! download "$base/$asset" >"$work/$asset"; then
    die "nova-ai $version has no binaries. The first version with them is in the alpha channel: add --channel alpha. Releases: $REPO_URL/releases"
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

  say "Installed nova-ai $version to $dir/nova-ai"
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
