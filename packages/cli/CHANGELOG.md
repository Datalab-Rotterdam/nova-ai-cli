# [@datalabrotterdam/nova-ai-cli-v1.2.0-alpha.3](https://github.com/Datalab-Rotterdam/nova-ai-cli/compare/@datalabrotterdam/nova-ai-cli@1.2.0-alpha.2...@datalabrotterdam/nova-ai-cli@1.2.0-alpha.3) (2026-10-04)


### Bug Fixes

* **agent:** never overwrite an unreadable settings file when switching a skill ([ca989ef](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/ca989ef1810fc903cea069cdadf3041fe164e364))
* **cli:** install the command as nova-ai only ([eda8064](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/eda806411af1738ff6f6b1404d23d4e84a74ced8))


### Features

* **agent,cli:** Nova skill folders, switching skills off, a budgeted skill list ([0891c79](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/0891c79248d3a645d638f12f46928a54652b0941))
* **cli:** update notice from npm for every channel, cached daily ([c3a0014](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/c3a001473336aac14d216cdeec0bedde4df34427))

# [@datalabrotterdam/nova-ai-cli-v1.2.0-alpha.2](https://github.com/Datalab-Rotterdam/nova-ai-cli/compare/@datalabrotterdam/nova-ai-cli@1.2.0-alpha.1...@datalabrotterdam/nova-ai-cli@1.2.0-alpha.2) (2026-10-03)


### Features

* release the agent separately as @datalabrotterdam/nova-ai-agent ([32ecfc0](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/32ecfc0faa99bd5bb80cb2eaf2363abc050978f0))

# [1.2.0-alpha.1](https://github.com/Datalab-Rotterdam/nova-ai-cli/compare/v1.1.0...v1.2.0-alpha.1) (2026-10-03)


### Bug Fixes

* **acp:** bounded, cancellable client terminals in the workspace ([81f7099](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/81f70996d9dfc8d78e12282def1582ea859f2784))
* **acp:** isolate background prompt jobs from live session history ([8328a8b](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/8328a8bfa1f22871ef36ec38247987e6effcd044))
* **acp:** replay loaded sessions faithfully; page session/list ([d576171](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/d5761710890f7b2f5d1b340cdce7faafcd2e3561))
* **env:** no shells or Docker probes when a session starts ([dc3a449](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/dc3a4495f394c1a16e48e282efd76b765af09999))
* **mcp:** connect servers in parallel with timeouts and diagnostics ([db4c62c](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/db4c62cd9c8ec0f197ea1ae1ce76adcf9d397ed5))
* **models:** offer and default to chat models only ([5d3ade2](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/5d3ade2727110ca7555bfdfa5b174c9e75b151f9))
* **security:** harden sessions, setup auth, credentials, processes and file access ([7f02a1d](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/7f02a1d203128555c4d00e5ab4dc4786329b6225))
* **tui:** keep printed lines inside the terminal width ([dd5cd0a](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/dd5cd0a40592af392eca797399ce56c0e672110e))
* **tui:** redraw cleanly after the terminal width changes ([f0b2ec6](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/f0b2ec6d01b0bd8ebcf087330c8bfd82072aa08d))


### Features

* **acp:** agentInfo and env_var authentication in initialize ([b736e11](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/b736e115542b8fef083f9fc75514586327d3ac49))
* **acp:** namespace Nova extensions under _nova/ ([bf56cb9](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/bf56cb9e093dc90fc43b44008f1ddd86446a8cd0))
* **acp:** serialized turns, cancel, shutdown and proper error codes ([6688470](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/66884701af129ff2c1e9ad78b9e572d7ec64cc4b))
* **acp:** the agent owns permissions; clients only answer its questions ([7db651d](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/7db651d8d4883da2c170a831aeaa2952dc4444ac))
* **acp:** usage, session info, commands and model options as updates ([21d0816](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/21d08160c558ca9431deff8f8ead25e89a93d21c))
* added alpha stage on TUI ([3415411](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/3415411986ef4aefc2aa94dbb66fc73710fb6a5d))
* **cli:** proper entry point, -p/--print, login/logout, help and version ([73c8f94](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/73c8f9472099fa7c3cedccdd3c6a315d809e6a00))
* **core:** allow multiple tool calls per round ([f6a2171](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/f6a217145efac0722fddc49995808a7ad7bb2508))
* **core:** compact proactively at 80% of the model context window ([96afcbb](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/96afcbb7b68f4686a9b769bb80a73b00eebfe4a4))
* **core:** native tool calling with learned per-model text fallback ([6d71193](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/6d7119395b39a45026d676813ad3596382e2611a))
* **core:** share the ~/.nova-ai project layout with the VS Code extension ([aa75dde](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/aa75dde65218fdbd16b9f329bd849cc9ec608a28))
* **core:** validate tool args centrally before dispatch ([0a88e3e](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/0a88e3efb0d7c32611979e408b95e659873ec1e5))
* expand ACP runtime and terminal workflows ([bfbae15](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/bfbae157c301fbc1b7e88f5e267d25c8da126008))
* **mcp:** surface tool schemas, respect readOnlyHint, hint cwd args ([2b22be3](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/2b22be327b052788936e4badb010844f7ca3d057))
* **memory:** shared MEMORY.md index + typed notes, compatible with VS Code ([474c916](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/474c91694f4da58400426f39c290ac6888f4aa19))
* **modes:** plan mode can read, ask and keep the task list ([e253eaa](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/e253eaa66fd02478d61f34e734a27883068bf357))
* **policy:** agent-side permission policy with trust-gated rule sources ([234cd3a](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/234cd3adf06423c973c52497e5e31f6868d6b19a))
* **policy:** rule subjects for the extension's tool names ([5c188b6](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/5c188b610ff6e4ba8a715cc2ee10960736493b86))
* **tools:** add JSON schema validator for tool args ([24764ef](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/24764ef5100c14404f1923f89cc87c3d64de510d))
* **tools:** declare args schemas on every built-in tool ([79f6283](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/79f62833144f1a6aba9aaa65a2a19f18eb8793ca))
* **tools:** whitespace-tolerant edit_file with self-correction hints ([a350e14](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/a350e140e92c8469249d4c6297aad8f8161a217f))
* **tui:** Ink TUI with inline scrollback replaces pi-tui ([0725bae](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/0725bae27790829fd756afbdb5dd20574a1e0f00))
* **tui:** Shift+Enter inserts a new line where the terminal can report it ([b9c0b70](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/b9c0b7041057e2bdeb1675bbfa33a12fc3a664b9))

# [1.1.0](https://github.com/Datalab-Rotterdam/nova-ai-cli/compare/v1.0.1...v1.1.0) (2026-06-23)


### Features

* **acp-web:** theme support, favicon, font, and dep bumps ([0576402](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/0576402b6888a2cf6bc93123d733c4163358c63f))
* **acp:** add MCP server support (stdio/http/sse) ([ba98b0c](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/ba98b0c0b2e2461e8553331cafa1985e7673ee43))

## [1.0.1](https://github.com/Datalab-Rotterdam/nova-ai-cli/compare/v1.0.0...v1.0.1) (2026-06-22)


### Bug Fixes

* correct npm scope to [@datalabrotterdam](https://github.com/datalabrotterdam) ([6ab6bf8](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/6ab6bf88506cc1d4b778c1a30b123cd532a0a8de))

# 1.0.0 (2026-06-22)


### Features

* add ACP agent, tool calling, and alpha release channel ([15d19a7](https://github.com/Datalab-Rotterdam/nova-ai-cli/commit/15d19a7998b4651ba9ad279fc2607006ea14ed49))
