# @datalabrotterdam/nova-ai-agent

The [Nova AI](https://platform.nova.datalabrotterdam.nl) coding agent as an
[Agent Client Protocol](https://agentclientprotocol.com) (ACP) server: tools,
permission policy, sessions, memory, MCP servers and context compaction,
backed by [`@datalabrotterdam/nova-sdk`](https://www.npmjs.com/package/@datalabrotterdam/nova-sdk).

This is the agent without a user interface, for editors and other programs
that speak ACP. For the interactive terminal UI and headless mode, install
[`@datalabrotterdam/nova-ai-cli`](https://www.npmjs.com/package/@datalabrotterdam/nova-ai-cli)
(`nova-ai`), which uses this package.

## Use it

```sh
npm install -g @datalabrotterdam/nova-ai-agent
nova-ai-agent login        # store a Nova API key (or set NOVA_API_KEY)
nova-ai-agent --acp        # ACP over stdin/stdout
```

Configure `nova-ai-agent --acp` as a custom agent in your editor. For Zed:

```json
{
  "agent_servers": {
    "Nova AI": { "command": "npx", "args": ["-y", "@datalabrotterdam/nova-ai-agent", "--acp"] }
  }
}
```

The protocol, the auth methods, the permission flow and Nova's `_nova/…`
extension methods are documented in
[docs/ACP.md](https://github.com/Datalab-Rotterdam/nova-ai-cli/blob/main/docs/ACP.md);
settings, trust, memory and session files in
[docs/NOVA_HOME.md](https://github.com/Datalab-Rotterdam/nova-ai-cli/blob/main/docs/NOVA_HOME.md).

## In the same process

```ts
import { NovaAgent, startInProcessAgent } from "@datalabrotterdam/nova-ai-agent";

const agent = startInProcessAgent(() => myAcpClient, new NovaAgent());
await agent.client.initialize({ protocolVersion: 1, clientCapabilities: {} });
```

`startInProcessAgent` connects a real ACP client to the agent over an
in-memory stream, so it behaves exactly like the separate process; prefer the
process when a hung turn or a crash must not affect the host. Only the package
root is a stable API; the `core/…`, `acp/…` and `client/…` subpaths serve
Nova's own front ends and may change.

Requires Node.js 22.19 or newer. License: Apache-2.0.
