# Package managers

Every CLI release attaches `nova-ai-packaging.tar.gz`, made by
`scripts/package-manifests.mjs` from that release's `SHA256SUMS`:

- `homebrew/nova-ai.rb` (a prerelease gives `nova-ai@alpha.rb`)
- `winget/<version>/DatalabRotterdam.NovaAI*.yaml` (stable releases only)

For now publishing is **manual**: after a CLI release, run
Actions > Publish packages (`.github/workflows/publish-packages.yml`) and enter the
version, for example `1.3.0`. It pushes the cask to the Homebrew tap and opens a
pull request to `microsoft/winget-pkgs`. Each job skips itself, with a notice, when
its secret is missing. CI used to call it after every release; the comment at the
end of `ci.yml` says how to switch that back on.

## One-time setup

Secrets go in this repository: Settings > Secrets and variables > Actions >
New repository secret (or `gh secret set NAME`). Both are personal access tokens
of an account that does the publishing; a machine account is better than a
person's, because the pull requests to winget-pkgs come from it.

### Homebrew: `HOMEBREW_TAP_TOKEN`

1. Create the repository `Datalab-Rotterdam/homebrew-tap` (public, with a first
   commit, for example a README).
2. Create a fine-grained token (GitHub > Settings > Developer settings >
   Personal access tokens > Fine-grained tokens): resource owner
   `Datalab-Rotterdam`, only the repository `homebrew-tap`, permission
   **Contents: Read and write**. Set an expiry and note it.
3. Save it as the secret `HOMEBREW_TAP_TOKEN`.

Users then run `brew install --cask datalab-rotterdam/tap/nova-ai`.

### winget: `WINGET_TOKEN`

The fork is `Datalab-Rotterdam/winget-pkgs` (already created). The job syncs it with
`microsoft/winget-pkgs`, pushes a branch `nova-ai-<version>` to it and opens the pull
request from there.

1. Pick a person or machine account that can push to the fork (a member of the org with
   write access to `winget-pkgs`). The pull request is opened as that account.
2. Create a **classic** token for it with the `public_repo` scope (a fine-grained token
   cannot open a pull request on `microsoft/winget-pkgs`). If the org uses SAML SSO,
   authorize the token for the org.
3. Save it as the secret `WINGET_TOKEN`.

The first submission is reviewed by a person; later ones are mostly validated by
a bot. Users then run `winget install DatalabRotterdam.NovaAI`. Alpha versions
are never submitted. The manifests have not been run through `winget validate`
yet: do `winget install --manifest <folder>` on Windows before the first PR.

## Notes

- The cask clears the macOS quarantine flag in `postflight` because the binaries
  are not notarized. Remove that block once they are.
- Tokens expire: when a publish job fails with a 401 or 403, renew the token and
  update the secret.
