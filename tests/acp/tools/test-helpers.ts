import type * as acp from "@agentclientprotocol/sdk";
import type { BackgroundToolApi } from "../../../src/acp/background.js";
import type { ToolContext } from "../../../src/acp/tools/types.js";
import type { ToolEnvironment } from "../../../src/acp/tools/environment.js";
import type { ToolHost } from "../../../src/core/tool-host.js";

export const FULL_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
  terminal: true,
  elicitation: { form: {} },
} as acp.ClientCapabilities;

export function makeEnvironment(
  overrides: Partial<ToolEnvironment> = {},
): ToolEnvironment {
  return {
    platform: "linux",
    commands: {
      git: true,
      node: true,
      npm: true,
      pnpm: false,
      yarn: false,
      python: false,
      python3: true,
      rg: false,
    },
    commandPaths: {
      git: ["/usr/bin/git"],
      node: ["/usr/bin/node"],
      npm: ["/usr/bin/npm"],
      python3: ["/usr/bin/python3"],
    },
    environmentVariableNames: ["HOME", "PATH", "SHELL"],
    toolingEnvironmentVariables: { SHELL: "/bin/sh" },
    pathEntries: ["/usr/local/bin", "/usr/bin"],
    docker: {
      installed: false,
      clientVersion: null,
      daemonAvailable: false,
      serverVersion: null,
      osType: null,
      architecture: null,
      context: null,
      composeCommand: null,
      composeVersion: null,
    },
    packageManager: "npm",
    packageScripts: ["test"],
    workspaceReadable: true,
    clientCapabilities: FULL_CAPABILITIES,
    ...overrides,
  };
}

export function makeToolContext(
  overrides: {
    host?: Partial<ToolHost>;
    background?: BackgroundToolApi;
    cwd?: string;
    environment?: Partial<ToolEnvironment>;
  } = {},
): ToolContext {
  const host: ToolHost = {
    readTextFile: async () => "",
    writeTextFile: async () => {},
    runCommand: async () => ({ output: "", truncated: false, exitCode: 0 }),
    ...overrides.host,
  };

  return {
    host,
    sessionId: "session-1",
    toolCallId: "tool-call-1",
    cwd: overrides.cwd ?? process.cwd(),
    environment: makeEnvironment(overrides.environment),
    background: overrides.background,
    signal: new AbortController().signal,
    requestPermission: async () => true,
  };
}
