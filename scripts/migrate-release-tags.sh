#!/usr/bin/env bash
# One-time migration to per-package release tags (run once, from a clone with
# push access, AFTER the last single-package release and BEFORE the first
# multi-package release).
#
# The CLI was released with tags like v1.1.0. The per-package release looks for
# "@datalabrotterdam/nova-ai-cli@1.1.0" instead. For every v* tag this creates
# the matching package tag on the same commit and copies semantic-release's
# channel note (refs/notes/semantic-release-<tag>), so the next release
# continues from the right version on the right channel (latest or alpha).
#
#   scripts/migrate-release-tags.sh          # show what would be created
#   scripts/migrate-release-tags.sh --push   # create and push tags + notes
set -euo pipefail

PACKAGE="@datalabrotterdam/nova-ai-cli"
PUSH=false
[[ "${1:-}" == "--push" ]] && PUSH=true

git fetch --quiet --tags origin
git fetch --quiet origin '+refs/notes/*:refs/notes/*'

created=()
for old in $(git tag --list 'v[0-9]*'); do
  new="${PACKAGE}@${old#v}"
  note=$(git notes --ref "semantic-release-${old}" show "${old}" 2>/dev/null \
    || git notes --ref semantic-release show "${old}" 2>/dev/null \
    || echo '{"channels":[null]}')
  if git rev-parse --quiet --verify "refs/tags/${new}" >/dev/null; then
    echo "exists   ${new}"
    continue
  fi
  echo "create   ${new} -> $(git rev-parse --short "${old}^{commit}")  ${note}"
  if $PUSH; then
    git tag "${new}" "${old}^{commit}"
    git notes --ref "semantic-release-${new}" add -f -m "${note}" "${new}"
    created+=("${new}")
  fi
done

if $PUSH && ((${#created[@]})); then
  for tag in "${created[@]}"; do
    git push --quiet origin "refs/tags/${tag}" "refs/notes/semantic-release-${tag}"
  done
  echo "pushed ${#created[@]} tag(s) with notes"
elif ! $PUSH; then
  echo "(dry run; pass --push to create and push)"
fi
