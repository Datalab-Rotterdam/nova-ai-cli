# Package managers

Every CLI release attaches `nova-ai-packaging.tar.gz`, made by
`scripts/package-manifests.mjs` from that release's `SHA256SUMS`:

- `homebrew/nova-ai.rb` (a prerelease gives `nova-ai@alpha.rb`)
- `winget/<version>/DatalabRotterdam.NovaAI*.yaml` (stable releases only)

Nothing publishes them on its own yet. One-time setup, then a manual step per release.

## Homebrew

1. Create the repository `Datalab-Rotterdam/homebrew-tap` with a `Casks/` folder.
2. Per release, copy `homebrew/nova-ai.rb` to `Casks/nova-ai.rb` and push.
3. Users: `brew install --cask datalab-rotterdam/tap/nova-ai`.

The cask clears the quarantine flag in `postflight` because the binaries are not
notarized. Remove that block once they are.

## winget

1. Per stable release, copy `winget/<version>/` to
   `manifests/d/DatalabRotterdam/NovaAI/<version>/` in a fork of
   `microsoft/winget-pkgs` and open a PR. Their bot validates it; the first
   submission is reviewed by a person.
2. Users: `winget install DatalabRotterdam.NovaAI`.

The first submission needs a tested install on Windows (`winget validate` and
`winget install --manifest <folder>`); the manifests are generated but not yet
run through winget.

## Automating it later

A token with push access to the tap (and `wingetcreate` for winget-pkgs) in CI
secrets would let the release job do both steps. Not set up.
