import * as acp from "@agentclientprotocol/sdk";

/**
 * Adapts an AgentContext-style client (request/notify by method name) to the
 * SDK's Client interface, so it can sit at the client end of a real ACP
 * connection. Every client→agent-callback is forwarded by its method name.
 */
export function clientFromContext(context: acp.AgentContext): acp.Client {
  const request = <T>(method: string, params: unknown): Promise<T> =>
    context.request(method, params) as Promise<T>;
  return {
    sessionUpdate: (params) => context.notify(acp.methods.client.session.update, params),
    requestPermission: (params) => request(acp.methods.client.session.requestPermission, params),
    readTextFile: (params) => request(acp.methods.client.fs.readTextFile, params),
    writeTextFile: async (params) =>
      (await request(acp.methods.client.fs.writeTextFile, params)) ?? {},
    createTerminal: (params) => request(acp.methods.client.terminal.create, params),
    terminalOutput: (params) => request(acp.methods.client.terminal.output, params),
    waitForTerminalExit: (params) => request(acp.methods.client.terminal.waitForExit, params),
    killTerminal: async (params) => (await request(acp.methods.client.terminal.kill, params)) ?? {},
    releaseTerminal: async (params) =>
      (await request(acp.methods.client.terminal.release, params)) ?? {},
    unstable_createElicitation: (params) => request(acp.methods.client.elicitation.create, params),
    extNotification: (method, params) => context.notify(method, params),
  };
}
