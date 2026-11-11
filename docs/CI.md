# Nova AI in CI

Run a Nova agent request in a pipeline: review a pull request, explain a failing
build, or fix something and push it. Both integrations run `nova-ai -p` headless
(see the CLI README, "Headless") with `--output-format json`.

## GitHub Actions

```yaml
name: Nova review
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write # only for `comment: true`

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # Nova diffs against the base branch
      - uses: Datalab-Rotterdam/nova-ai-cli@main
        with:
          api-key: ${{ secrets.NOVA_API_KEY }}
          prompt: Review the changes in this pull request against origin/${{ github.base_ref }}. List bugs first.
          comment: true
```

| Input | Default | |
|---|---|---|
| `prompt` | (required) | What Nova should do |
| `api-key` | (required) | A Nova API key, from a secret |
| `permission-mode` | `read-only` | `read-only`, `accept-edits` or `bypass-all` (see "Security") |
| `model` | the account's default | Model id |
| `working-directory` | `.` | Workspace directory |
| `comment` | `false` | `true` posts the answer on the pull request |
| `github-token` | `github.token` | Token for the comment |
| `version` | `alpha` | Version or dist-tag of `@datalabrotterdam/nova-ai-cli` |
| `base-url` | the default gateway | Nova gateway URL |

Outputs: `text` (the answer), `exit-code`, and `result-file` (the JSON result,
on this runner; upload it with `actions/upload-artifact` to keep it). The
answer also goes to the job summary. A non-zero exit code fails the step after
the comment is posted.

## GitLab CI

```yaml
include:
  - remote: https://raw.githubusercontent.com/Datalab-Rotterdam/nova-ai-cli/main/ci/gitlab/nova-ai.yml

nova-review:
  extends: .nova-ai
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  variables:
    NOVA_PROMPT: Review the changes in this merge request against origin/$CI_MERGE_REQUEST_TARGET_BRANCH_NAME. List bugs first.
    NOVA_COMMENT: "true"
```

Set `NOVA_API_KEY` as a masked CI/CD variable. `NOVA_COMMENT: "true"` also
needs `NOVA_GITLAB_TOKEN`: a project access token with the `api` scope (the job
token cannot post notes). Other variables: `NOVA_PERMISSION_MODE` (default
`read-only`), `NOVA_MODEL`, `NOVA_VERSION` (default `alpha`). The job keeps
`nova-ai-result.json` and `nova-ai-answer.md` as artifacts.

To pin the template, include a tag or commit instead of `main`, or copy the file
into your repository.

## Exit codes

| Code | |
|---|---|
| `0` | Success |
| `1` | Configuration or runtime error (no API key, unknown model, gateway down) |
| `2` | Cancelled |
| `3` | The tool-turn safety limit was reached; the answer may be incomplete |

## Security

- **Keep `read-only` for anything a stranger can trigger.** In read-only mode
  nothing that needs approval runs: no file edits, no commands. A pull request
  can contain text written to steer Nova (prompt injection); with
  `bypass-all` that text could run commands with the job's secrets.
- **Fork pull requests get no secrets.** On `pull_request` from a fork GitHub
  does not pass `secrets.NOVA_API_KEY`, so the job fails with exit code 1. That
  is the safe outcome. Do not switch to `pull_request_target` to get the
  secret while checking out the fork's code: that runs untrusted code with
  your secrets. GitLab likewise only passes protected variables to protected
  branches; keep `NOVA_API_KEY` protected and masked.
- **`accept-edits` and `bypass-all` are for trusted triggers only**, such as
  `workflow_dispatch`, a schedule or pushes to your own branches. Give the job
  only the permissions it needs (`contents: write` to push, nothing more).
- **The workspace is not trusted** in CI: MCP servers and allow rules the
  repository declares are not used. `--trust-workspace` would turn them on;
  the templates leave it off on purpose.
- **Prompts never reach the shell.** Both templates pass the prompt as an
  environment variable and a single argument, so a PR title or branch name in
  the prompt cannot inject commands.
