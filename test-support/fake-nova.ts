import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FakeRequest = { url: string; body: Record<string, unknown>; signal?: AbortSignal | null };
export type FakeReply = Response | ((request: FakeRequest) => Response | Promise<Response>);

/** One SSE completion. `holdUntilAborted` keeps the stream open until the request is aborted. */
export function sse(
  chunks: Array<Record<string, unknown>>,
  options: { holdUntilAborted?: AbortSignal | null } = {},
): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      const signal = options.holdUntilAborted;
      if (signal) {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
        controller.error(new DOMException("The operation was aborted.", "AbortError"));
        return;
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export const text = (content: string) => ({ choices: [{ delta: { content }, finish_reason: "stop" }] });

/**
 * Replaces fetch with a fake Nova gateway for the duration of `run`:
 * /models answers one model, chat completions are answered by `reply`.
 */
export async function withFakeNova(
  reply: (request: FakeRequest, index: number) => Response | Promise<Response>,
  run: (requests: FakeRequest[], home: string) => Promise<void>,
): Promise<void> {
  const previous = {
    fetch: globalThis.fetch,
    apiKey: process.env.NOVA_API_KEY,
    model: process.env.NOVA_MODEL,
    home: process.env.NOVA_AI_HOME,
    sessions: process.env.NOVA_AI_CLI_SESSIONS_DIR,
  };
  const home = mkdtempSync(join(tmpdir(), "nova-fake-"));
  process.env.NOVA_API_KEY = "test-key";
  process.env.NOVA_MODEL = "fake-model";
  process.env.NOVA_AI_HOME = home;
  process.env.NOVA_AI_CLI_SESSIONS_DIR = join(home, "sessions");
  const requests: FakeRequest[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/providers")) {
      return new Response(
        JSON.stringify({ object: "list", data: [{ id: "x", object: "provider", name: "Fake" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/models")) {
      return new Response(
        JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model", created: 0, owned_by: "x", context_window: 100000 }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const request = { url, body: JSON.parse(String(init?.body)) as Record<string, unknown>, signal: init?.signal };
    requests.push(request);
    return reply(request, requests.length - 1);
  }) as typeof fetch;
  try {
    await run(requests, home);
  } finally {
    globalThis.fetch = previous.fetch;
    for (const [key, value] of [
      ["NOVA_API_KEY", previous.apiKey],
      ["NOVA_MODEL", previous.model],
      ["NOVA_AI_HOME", previous.home],
      ["NOVA_AI_CLI_SESSIONS_DIR", previous.sessions],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
}
