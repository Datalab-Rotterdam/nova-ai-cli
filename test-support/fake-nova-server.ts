import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export type ScriptedReply =
  | { chunks: Array<Record<string, unknown>> }
  | { holdUntilClosed: true };

/**
 * A real HTTP Nova gateway for tests that run the CLI as a separate process
 * (NOVA_BASE_URL=<url>). Chat completions are answered from `script`, one
 * entry per request, in order.
 */
export async function startFakeNovaServer(script: ScriptedReply[]): Promise<{
  url: string;
  requests: Array<Record<string, unknown>>;
  close(): Promise<void>;
}> {
  const requests: Array<Record<string, unknown>> = [];
  const open = new Set<ServerResponse>();
  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await new Promise<string>((resolve) => {
      let data = "";
      req.on("data", (chunk) => (data += chunk));
      req.on("end", () => resolve(data));
    });
    const json = (value: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    const path = new URL(req.url ?? "/", "http://fake").pathname;
    if (path.endsWith("/models")) {
      return json({
        object: "list",
        data: [{ id: "fake-model", object: "model", created: 0, owned_by: "x", context_window: 100000 }],
      });
    }
    if (path.endsWith("/providers")) {
      return json({ object: "list", data: [{ id: "x", object: "provider", name: "Fake" }] });
    }
    if (!path.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    requests.push(JSON.parse(body) as Record<string, unknown>);
    const reply = script.shift() ?? { chunks: [{ choices: [{ delta: { content: "(no script)" }, finish_reason: "stop" }] }] };
    res.writeHead(200, { "content-type": "text/event-stream" });
    if ("holdUntilClosed" in reply) {
      open.add(res);
      res.on("close", () => open.delete(res));
      return;
    }
    for (const chunk of reply.chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const res of open) res.destroy();
        server.close(() => resolve());
      }),
  };
}

export const toolCall = (id: string, name: string, args: unknown) => ({
  choices: [
    {
      delta: {
        tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    },
  ],
});
export const finish = (reason: string) => ({ choices: [{ delta: {}, finish_reason: reason }] });
export const say = (content: string) => ({ choices: [{ delta: { content }, finish_reason: "stop" }] });
