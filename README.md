<div align="center">

<img src="./assets/logo.png" width="96" height="96" alt="Nova logo" />

# Nova AI agent and CLI

**Agentic coding with DataLab Rotterdam's Nova AI: in your terminal, in scripts, and in your editor over the Agent Client Protocol**

</div>

This repository holds two npm packages that are versioned and released
separately:

| Package | What it is | Install |
|---|---|---|
| [`@datalabrotterdam/nova-ai-cli`](./packages/cli) | `nova-ai`: the interactive terminal UI, headless mode (`-p`) and `--acp` | `npm i -g @datalabrotterdam/nova-ai-cli` |
| [`@datalabrotterdam/nova-ai-agent`](./packages/agent) | `nova-ai-agent`: the agent alone, as an ACP server, without any UI libraries; what editors and the VS Code extension embed | `npm i -g @datalabrotterdam/nova-ai-agent` |

The CLI depends on the agent and talks to it over ACP in the same process,
exactly like an editor does over stdio. User documentation:
[packages/cli/README.md](./packages/cli/README.md). Protocol reference for
integrators: [docs/ACP.md](./docs/ACP.md). The shared `~/.nova-ai` layout
(settings, trust, memory, sessions): [docs/NOVA_HOME.md](./docs/NOVA_HOME.md).

## Layout

```
packages/agent/   core/ (agent loop, tools, policy, memory, sessions, MCP)
                  acp/ (ACP server, _nova/ extensions), client/ (in-process client),
                  commands/ (login/logout); bin: nova-ai-agent
packages/cli/     tui/ (Ink), headless/, cli.ts; bin: nova-ai
test-support/     fake Nova gateway and test setup shared by both packages
docs/             ACP.md, NOVA_HOME.md
```

`core/` never imports `acp/`, `client/` or `commands/`, and the agent package
never imports the CLI or UI libraries; a test enforces both.

## Development

```sh
npm ci
npm test               # builds the agent library, then type checks and tests both packages
npm run build          # the agent (incl. its login page) and the CLI bundle
npm run dev            # the CLI from source (tsx)
```

Per package: `npm run test:unit -w @datalabrotterdam/nova-ai-agent`, and
`npm run test:pty -w @datalabrotterdam/nova-ai-cli` for the real-terminal
scenario. Tests run with a throwaway home folder and never reach the real Nova
gateway. On macOS run `chmod +x node_modules/node-pty/prebuilds/*/spawn-helper`
once after installing (npm 11 skips node-pty's install script).

## Releases

Each package is released on its own by
[semantic-release](https://semantic-release.gitbook.io) with
[semantic-release-monorepo](https://github.com/pmowrer/semantic-release-monorepo),
from the conventional commits that touch its folder: `main` publishes to the
`latest` tag, `alpha` to the `alpha` tag. Tags are `<package>@<version>`.

- A change in only `packages/agent` releases only the agent; one in only
  `packages/cli` only the CLI; a commit touching both releases both (the agent
  first).
- The CLI declares its agent range (`^1.0.0-alpha.1`, which covers every 1.x).
  New installs of the CLI get the newest agent in that range without a CLI
  release. A new agent major needs a commit that raises the range, which
  releases the CLI.

A manual run of the CI workflow on `main` or `alpha` with "release dry run"
shows what would be released without publishing.

**One-time migration**: the CLI used tags like `v1.1.0`. Before the first
release from this layout, run `scripts/migrate-release-tags.sh` (dry run) and
then `scripts/migrate-release-tags.sh --push`. It adds
`@datalabrotterdam/nova-ai-cli@<version>` tags with the same release channels.

## License

[Apache-2.0](./LICENSE) © DataLab Rotterdam
