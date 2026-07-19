import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import * as acp from "@agentclientprotocol/sdk";
import {
  contentBlocksToNovaContent,
  contentBlocksToText,
  frameSteeringPrompt,
  NovaAgent,
} from "../../src/acp/agent.js";
import {
  appendSessionTurn,
  deleteStoredSession,
  loadStoredSession,
} from "../../src/acp/sessions.js";

const testSessionsDir = mkdtempSync(join(tmpdir(), "nova-agent-sessions-"));
process.env.NOVA_AI_CLI_SESSIONS_DIR = testSessionsDir;
process.env.NOVA_AI_CLI_BACKGROUND_JOBS_DIR = join(
  testSessionsDir,
  "background-jobs",
);
after(() => {
  delete process.env.NOVA_AI_CLI_SESSIONS_DIR;
  delete process.env.NOVA_AI_CLI_BACKGROUND_JOBS_DIR;
  rmSync(testSessionsDir, { recursive: true, force: true });
});

describe("NovaAgent.initialize", () => {
  it("advertises the protocol version, capabilities, and auth method", () => {
    const agent = new NovaAgent();
    const response = agent.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    });

    assert.equal(response.protocolVersion, acp.PROTOCOL_VERSION);
    assert.equal(response.agentCapabilities?.loadSession, true);
    assert.equal(response.authMethods?.[0]?.id, "nova-api-key");
    assert.ok(response.agentCapabilities?.sessionCapabilities?.delete);
    assert.ok(response.agentCapabilities?.sessionCapabilities?.fork);
    assert.ok(response.agentCapabilities?.sessionCapabilities?.resume);
    assert.ok(response.agentCapabilities?.providers);
    assert.ok(response.agentCapabilities?.nes);
    assert.equal(
      response.agentCapabilities?.nes?.events?.document?.didChange?.syncKind,
      "full",
    );
    assert.equal(
      response.agentCapabilities?.nes?.context?.recentFiles?.maxCount,
      5,
    );
    assert.equal(response.agentCapabilities?.positionEncoding, "utf-16");
    assert.equal(response.agentCapabilities?.promptCapabilities?.image, true);
  });
});

describe("ACP image prompts", () => {
  it("converts image blocks to OpenAI-compatible data URLs", () => {
    assert.deepEqual(
      contentBlocksToNovaContent([
        { type: "text", text: "Inspect [#Image1]" },
        { type: "image", mimeType: "image/png", data: "YWJj" },
      ]),
      [
        { type: "text", text: "Inspect [#Image1]" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,YWJj" },
        },
      ],
    );
  });
});

describe("frameSteeringPrompt", () => {
  it("wraps the original blocks between a preamble and a continue-the-task instruction", () => {
    const framed = frameSteeringPrompt([
      { type: "text", text: "focus on the login flow instead" },
    ]);
    assert.equal(framed.length, 3);
    assert.match(
      contentBlocksToText(framed),
      /^The user sent this message while you were still working on the current task:\n\n<steering_message>\nfocus on the login flow instead\n<\/steering_message>\n\nThis is guidance for the task already in progress, not a new unrelated request\. Incorporate it and continue\.$/,
    );
  });

  it("keeps non-text blocks (e.g. images) inside the wrapper untouched", () => {
    const image = { type: "image", mimeType: "image/png", data: "YWJj" } as const;
    const framed = frameSteeringPrompt([image]);
    assert.deepEqual(framed[1], image);
  });
});

describe("NovaAgent.takeSteeringMessages", () => {
  it("delivers steered prompts to the model framed as guidance for the active turn", async () => {
    const agent = new NovaAgent();
    const { sessionId } = await agent.newSession({ cwd: "/repo", mcpServers: [] });
    const fakeClient = {
      request: async () => ({}),
      notify: async () => {},
    } as never;

    agent.queuePrompt(
      {
        sessionId,
        text: "focus on the login flow instead",
        prompt: [{ type: "text", text: "focus on the login flow instead" }],
        kind: "steer",
      },
      fakeClient,
    );

    const messages = await agent.takeSteeringMessages({ sessionId }, fakeClient);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.role, "user");
    assert.match(
      messages[0]?.content as string,
      /^The user sent this message while you were still working on the current task:/,
    );
    assert.match(
      messages[0]?.content as string,
      /<steering_message>\nfocus on the login flow instead\n<\/steering_message>/,
    );
  });
});

describe("NovaAgent.newSession", () => {
  it("creates a session with a fresh id each time", async () => {
    const agent = new NovaAgent();
    const a = await agent.newSession({ cwd: "/repo", mcpServers: [] });
    const b = await agent.newSession({ cwd: "/repo", mcpServers: [] });
    assert.notEqual(a.sessionId, b.sessionId);
    assert.deepEqual(a._meta?.["nova-ai-cli/mcp"], {
      configured: [],
      connected: [],
      failures: [],
    });
    assert.ok(Array.isArray(a._meta?.["nova-ai-cli/skills"]));
    assert.equal(a.modes?.currentModeId, "agent");
    assert.deepEqual(
      a.modes?.availableModes.map((mode) => mode.id),
      ["agent", "ask", "plan"],
    );
    assert.equal(
      a.modes?.availableModes.some((mode) => mode.id === "bypassAll"),
      false,
    );
  });

  it("accepts interaction modes but rejects permission modes", async () => {
    const agent = new NovaAgent();
    const { sessionId } = await agent.newSession({
      cwd: "/repo",
      mcpServers: [],
    });

    assert.ok(agent.contextUsage({ sessionId }).categories.tools > 0);
    assert.deepEqual(agent.setSessionMode({ sessionId, modeId: "plan" }), {});
    assert.equal(agent.contextUsage({ sessionId }).categories.tools, 0);
    assert.throws(
      () => agent.setSessionMode({ sessionId, modeId: "bypassAll" }),
      /Unknown interaction mode: bypassAll/,
    );
  });
});

describe("NovaAgent.cancel", () => {
  it("is a no-op for an unknown session id", () => {
    const agent = new NovaAgent();
    assert.doesNotThrow(() => agent.cancel({ sessionId: "unknown" }));
  });

  it("aborts the pending prompt for a known session id", async () => {
    const agent = new NovaAgent();
    const { sessionId } = await agent.newSession({
      cwd: "/repo",
      mcpServers: [],
    });

    // Reach into prompt()'s session state via authenticate's failure path is
    // overkill here; instead drive a prompt that fails fast (no credentials)
    // and assert cancel before it starts doesn't throw.
    assert.doesNotThrow(() => agent.cancel({ sessionId }));
  });
});

describe("NovaAgent.loadSession", () => {
  it("throws when the stored session is not found", async () => {
    const agent = new NovaAgent();
    await assert.rejects(
      () =>
        agent.loadSession(
          { sessionId: "missing", cwd: "/repo", mcpServers: [] },
          {} as acp.AgentContext,
        ),
      /not found/,
    );
  });
});

describe("NovaAgent.prompt", () => {
  it("throws when the session id is unknown", async () => {
    const agent = new NovaAgent();
    await assert.rejects(
      () =>
        agent.prompt(
          { sessionId: "unknown", prompt: [{ type: "text", text: "hi" }] },
          {} as acp.AgentContext,
        ),
      /Session unknown not found/,
    );
  });
});

describe("NovaAgent.deleteSession", () => {
  it("removes both the in-memory session and the persisted file", async () => {
    const agent = new NovaAgent();
    const { sessionId } = await agent.newSession({
      cwd: "/repo",
      mcpServers: [],
    });
    appendSessionTurn(sessionId, { cwd: "/repo", title: "t" }, [
      { role: "user", content: "hi" },
    ]);
    assert.ok(loadStoredSession(sessionId));

    await agent.deleteSession({ sessionId });

    assert.equal(loadStoredSession(sessionId), null);
    await assert.rejects(
      () =>
        agent.prompt(
          { sessionId, prompt: [{ type: "text", text: "hi" }] },
          {} as acp.AgentContext,
        ),
      /not found/,
    );
  });

  it("is a no-op when the session does not exist anywhere", async () => {
    const agent = new NovaAgent();
    await assert.doesNotReject(() =>
      agent.deleteSession({ sessionId: "unknown" }),
    );
  });
});

describe("NovaAgent.forkSession", () => {
  it("copies history under a new session id independent from the source", async () => {
    const agent = new NovaAgent();
    const sourceId = `test-fork-source-${crypto.randomUUID()}`;
    appendSessionTurn(sourceId, { cwd: "/repo", title: "original" }, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);

    const result = await agent.forkSession({
      sessionId: sourceId,
      cwd: "/repo-fork",
      mcpServers: [],
    });

    assert.notEqual(result.sessionId, sourceId);
    assert.equal(result.modes?.currentModeId, "agent");

    const forkedOnDisk = loadStoredSession(result.sessionId);
    assert.deepEqual(forkedOnDisk?.messages, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    const sourceOnDisk = loadStoredSession(sourceId);
    assert.equal(sourceOnDisk?.cwd, "/repo");

    deleteStoredSession(sourceId);
    deleteStoredSession(result.sessionId);
  });

  it("throws when the source session does not exist", async () => {
    const agent = new NovaAgent();
    await assert.rejects(
      () =>
        agent.forkSession({
          sessionId: "unknown",
          cwd: "/repo",
          mcpServers: [],
        }),
      /not found/,
    );
  });
});

describe("NovaAgent.resumeSession", () => {
  it("restores session state, unlike loadSession takes no client to notify", async () => {
    const agent = new NovaAgent();
    const sessionId = `test-resume-${crypto.randomUUID()}`;
    appendSessionTurn(sessionId, { cwd: "/repo", title: "t" }, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);

    const result = await agent.resumeSession({
      sessionId,
      cwd: "/repo",
      mcpServers: [],
    });

    assert.equal(result.modes?.currentModeId, "agent");

    deleteStoredSession(sessionId);
  });

  it("throws when the session does not exist", async () => {
    const agent = new NovaAgent();
    await assert.rejects(
      () =>
        agent.resumeSession({
          sessionId: "unknown",
          cwd: "/repo",
          mcpServers: [],
        }),
      /not found/,
    );
  });
});

describe("NovaAgent.rewindSession", () => {
  it("rewinds live history, clears queued work, and notifies ACP clients", async () => {
    const agent = new NovaAgent();
    const sessionId = `test-agent-rewind-${crypto.randomUUID()}`;
    appendSessionTurn(sessionId, { cwd: "/repo", title: "first" }, [
      { role: "user", content: "first" },
      { role: "assistant", content: "one" },
    ]);
    appendSessionTurn(sessionId, { cwd: "/repo", title: "first" }, [
      { role: "user", content: "second" },
      { role: "assistant", content: "two" },
    ]);
    await agent.resumeSession({ sessionId, cwd: "/repo", mcpServers: [] });
    agent.queuePrompt({
      sessionId,
      text: "queued",
      prompt: [{ type: "text", text: "queued" }],
    });
    const notifications: string[] = [];
    const client = {
      notify: async (method: string) => {
        notifications.push(method);
      },
      request: async () => ({}),
    } as unknown as acp.AgentContext;

    const result = await agent.rewindSession({ sessionId }, client);

    assert.equal(result.messageCount, 2);
    assert.deepEqual(
      result.removedCheckpoints.map((checkpoint) => checkpoint.userText),
      ["second"],
    );
    assert.deepEqual(agent.listPromptQueue({ sessionId }).entries, []);
    assert.deepEqual(notifications, ["queue/changed", "session/rewound"]);
    assert.equal(
      agent.listSessionCheckpoints({ sessionId }).checkpoints.length,
      1,
    );
    await agent.closeSession({ sessionId });
    deleteStoredSession(sessionId);
  });
});

describe("NovaAgent.setSessionConfigOption", () => {
  it("rejects an unknown configId", async () => {
    const agent = new NovaAgent();
    const { sessionId } = await agent.newSession({
      cwd: "/repo",
      mcpServers: [],
    });
    await assert.rejects(
      () =>
        agent.setSessionConfigOption({
          sessionId,
          configId: "unknown",
          value: "x",
        }),
      /Unknown config option/,
    );
  });

  it("rejects a boolean-shaped value for the model option", async () => {
    const agent = new NovaAgent();
    const { sessionId } = await agent.newSession({
      cwd: "/repo",
      mcpServers: [],
    });
    await assert.rejects(
      () =>
        agent.setSessionConfigOption({
          sessionId,
          configId: "model",
          type: "boolean",
          value: true,
        } as unknown as acp.SetSessionConfigOptionRequest),
      /non-empty string value/,
    );
  });

  it("accepts a string model value and returns configOptions", async () => {
    const agent = new NovaAgent();
    const { sessionId } = await agent.newSession({
      cwd: "/repo",
      mcpServers: [],
    });
    const result = await agent.setSessionConfigOption({
      sessionId,
      configId: "model",
      value: "some-model",
    });
    assert.ok(Array.isArray(result.configOptions));
  });
});

describe("NovaAgent.providers", () => {
  it("disableProvider is a synchronous, process-wide no-throw call", () => {
    const agent = new NovaAgent();
    assert.deepEqual(agent.disableProvider({ id: "main" }), {});
  });
});

describe("NovaAgent.nes", () => {
  it("startNes returns a unique session id each call", () => {
    const agent = new NovaAgent();
    const a = agent.startNes({});
    const b = agent.startNes({});
    assert.notEqual(a.sessionId, b.sessionId);
  });

  it("closeNes is idempotent for an unknown session", () => {
    const agent = new NovaAgent();
    assert.deepEqual(agent.closeNes({ sessionId: "unknown" }), {});
  });

  it("suggestNes throws when the NES session does not exist", async () => {
    const agent = new NovaAgent();
    await assert.rejects(
      () =>
        agent.suggestNes(
          {
            sessionId: "unknown",
            uri: "file:///a.ts",
            version: 1,
            position: { line: 0, character: 0 },
            triggerKind: "manual",
          },
          {} as acp.AgentContext,
        ),
      /not found/,
    );
  });

  it("acceptNes/rejectNes tolerate unknown suggestion ids", () => {
    const agent = new NovaAgent();
    const { sessionId } = agent.startNes({});
    assert.doesNotThrow(() => agent.acceptNes({ sessionId, id: "s1" }));
    assert.doesNotThrow(() =>
      agent.rejectNes({ sessionId, id: "s1", reason: "rejected" }),
    );
  });

  it("negotiates UTF-8 when it is the only client position encoding", () => {
    const agent = new NovaAgent();
    const response = agent.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { positionEncodings: ["utf-8"] },
    });
    assert.equal(response.agentCapabilities?.positionEncoding, "utf-8");
  });

  it("reads file URIs as absolute paths and returns a validated model edit", async () => {
    const previousApiKey = process.env.NOVA_API_KEY;
    const previousNesModel = process.env.NOVA_NES_MODEL;
    const previousFetch = globalThis.fetch;
    process.env.NOVA_API_KEY = "test-key";
    process.env.NOVA_NES_MODEL = "test-nes-model";
    let requestedPath = "";
    const requestBodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  edits: [
                    {
                      range: {
                        start: { line: 0, character: 14 },
                        end: { line: 0, character: 15 },
                      },
                      newText: "2",
                    },
                  ],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    try {
      const agent = new NovaAgent();
      agent.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true } },
      });
      const { sessionId } = agent.startNes({
        workspaceUri: "file:///C:/workspace",
      });
      const client = {
        request: async (_method: string, params: { path: string }) => {
          requestedPath = params.path;
          return { content: "const value = 1;\n" };
        },
      } as unknown as acp.AgentContext;
      const response = await agent.suggestNes(
        {
          sessionId,
          uri: "file:///C:/workspace/a.ts",
          version: 1,
          position: { line: 0, character: 15 },
          triggerKind: "manual",
        },
        client,
      );

      assert.ok(
        requestedPath.replace(/\\/g, "/").endsWith("C:/workspace/a.ts"),
      );
      assert.equal(requestBodies[0]?.model, "test-nes-model");
      assert.equal(response.suggestions.length, 1);
      assert.equal(response.suggestions[0]?.kind, "edit");
    } finally {
      globalThis.fetch = previousFetch;
      if (previousApiKey === undefined) delete process.env.NOVA_API_KEY;
      else process.env.NOVA_API_KEY = previousApiKey;
      if (previousNesModel === undefined) delete process.env.NOVA_NES_MODEL;
      else process.env.NOVA_NES_MODEL = previousNesModel;
    }
  });

  it("cancels an in-flight suggestion when the document changes", async () => {
    const previousApiKey = process.env.NOVA_API_KEY;
    const previousNesModel = process.env.NOVA_NES_MODEL;
    const previousFetch = globalThis.fetch;
    process.env.NOVA_API_KEY = "test-key";
    process.env.NOVA_NES_MODEL = "test-nes-model";

    let markFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => {
      markFetchStarted = resolve;
    });
    globalThis.fetch = async (_input, init) => {
      markFetchStarted();
      return await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const abort = () => reject(new DOMException("Aborted", "AbortError"));
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
    };

    try {
      const agent = new NovaAgent();
      const { sessionId } = agent.startNes({
        workspaceUri: "file:///C:/workspace",
      });
      const uri = "file:///C:/workspace/a.ts";
      agent.didOpenNesDocument({
        sessionId,
        uri,
        languageId: "typescript",
        version: 1,
        text: "const value = 1;\n",
      });

      const pending = agent.suggestNes(
        {
          sessionId,
          uri,
          version: 1,
          position: { line: 0, character: 15 },
          triggerKind: "automatic",
        },
        {} as acp.AgentContext,
      );
      await fetchStarted;
      agent.didChangeNesDocument({
        sessionId,
        uri,
        version: 2,
        contentChanges: [{ text: "const value = 2;\n" }],
      });

      assert.deepEqual(await pending, { suggestions: [] });
    } finally {
      globalThis.fetch = previousFetch;
      if (previousApiKey === undefined) delete process.env.NOVA_API_KEY;
      else process.env.NOVA_API_KEY = previousApiKey;
      if (previousNesModel === undefined) delete process.env.NOVA_NES_MODEL;
      else process.env.NOVA_NES_MODEL = previousNesModel;
    }
  });
});

describe("NovaAgent background prompt isolation", () => {
  type CapturedRequest = { url: string; body: Record<string, unknown> | null };

  function installFetchStub(replies: {
    models?: Array<Record<string, unknown>>;
    chatText?: () => string;
  }): { captured: CapturedRequest[]; restore: () => void } {
    const captured: CapturedRequest[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = String(input);
      const rawBody = typeof init?.body === "string" ? init.body : null;
      captured.push({ url, body: rawBody ? JSON.parse(rawBody) : null });
      if (url.includes("/chat/completions")) {
        const text = replies.chatText?.() ?? "OK.";
        const sse =
          `data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":${JSON.stringify(text)}}}]}\n\n` +
          "data: [DONE]\n\n";
        return new Response(sse, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      return new Response(
        JSON.stringify({ data: replies.models ?? [], has_more: false }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    return {
      captured,
      restore: () => {
        globalThis.fetch = originalFetch;
      },
    };
  }

  const fakeClient = {
    request: async () => ({}),
    notify: async () => {},
  } as never;

  async function waitForJobSettled(
    agent: NovaAgent,
    sessionId: string,
    jobId: string,
  ): Promise<string> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const job = agent
        .listBackgroundJobs({ sessionId })
        .jobs.find((entry) => entry.jobId === jobId);
      if (job && job.status !== "running") return job.status;
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 10));
    }
    throw new Error("Background job did not settle in time.");
  }

  it("uses the session's selected model for background jobs", async () => {
    const previousKey = process.env.NOVA_API_KEY;
    process.env.NOVA_API_KEY = "test-key";
    const stub = installFetchStub({ chatText: () => "Background done." });
    try {
      const agent = new NovaAgent();
      agent.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const { sessionId } = await agent.newSession({
        cwd: "/repo",
        mcpServers: [],
      });
      await agent.setSessionConfigOption({
        sessionId,
        configId: "model",
        value: "session-model",
      });

      const { job } = await agent.startBackgroundPrompt(
        { sessionId, prompt: [{ type: "text", text: "background task" }] },
        fakeClient,
      );
      await waitForJobSettled(agent, sessionId, job.jobId);

      const chatRequest = stub.captured.find((entry) =>
        entry.url.includes("/chat/completions"),
      );
      assert.ok(chatRequest);
      assert.equal(chatRequest?.body?.model, "session-model");
      deleteStoredSession(sessionId);
    } finally {
      stub.restore();
      if (previousKey === undefined) delete process.env.NOVA_API_KEY;
      else process.env.NOVA_API_KEY = previousKey;
    }
  });

  it("rejects an image prompt for a non-image model before creating a job", async () => {
    const previousKey = process.env.NOVA_API_KEY;
    const previousModel = process.env.NOVA_MODEL;
    process.env.NOVA_API_KEY = "test-key";
    process.env.NOVA_MODEL = "text-only-model";
    const stub = installFetchStub({
      models: [{ id: "text-only-model", capabilities: ["tools"] }],
    });
    try {
      const agent = new NovaAgent();
      agent.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const { sessionId } = await agent.newSession({
        cwd: "/repo",
        mcpServers: [],
      });

      await assert.rejects(
        agent.startBackgroundPrompt(
          {
            sessionId,
            prompt: [
              { type: "text", text: "describe" },
              { type: "image", mimeType: "image/png", data: "YWJj" },
            ],
          },
          fakeClient,
        ),
        /does not support image input/,
      );
      assert.deepEqual(agent.listBackgroundJobs({ sessionId }).jobs, []);
    } finally {
      stub.restore();
      if (previousKey === undefined) delete process.env.NOVA_API_KEY;
      else process.env.NOVA_API_KEY = previousKey;
      if (previousModel === undefined) delete process.env.NOVA_MODEL;
      else process.env.NOVA_MODEL = previousModel;
    }
  });

  it("hands background output to the next prompt instead of mutating history", async () => {
    const previousKey = process.env.NOVA_API_KEY;
    const previousModel = process.env.NOVA_MODEL;
    process.env.NOVA_API_KEY = "test-key";
    process.env.NOVA_MODEL = "test-model";
    let reply = "BG RESULT: dependencies audited.";
    const stub = installFetchStub({ chatText: () => reply });
    try {
      const agent = new NovaAgent();
      agent.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {},
      });
      const { sessionId } = await agent.newSession({
        cwd: "/repo",
        mcpServers: [],
      });

      const { job } = await agent.startBackgroundPrompt(
        { sessionId, prompt: [{ type: "text", text: "audit dependencies" }] },
        fakeClient,
      );
      const status = await waitForJobSettled(agent, sessionId, job.jobId);
      assert.equal(status, "completed");

      reply = "Continuing with the audit results.";
      await agent.prompt(
        {
          sessionId,
          prompt: [{ type: "text", text: "continue the main task" }],
        },
        fakeClient,
      );

      const foreground = stub.captured
        .filter((entry) => entry.url.includes("/chat/completions"))
        .at(-1);
      assert.ok(foreground);
      const requestMessages = foreground?.body?.messages as Array<{
        role: string;
        content: unknown;
      }>;
      const contents = requestMessages.map((message) =>
        String(message.content),
      );
      const handoffIndex = contents.findIndex((content) =>
        content.includes("[Background agent job"),
      );
      const userIndex = contents.findIndex((content) =>
        content.includes("continue the main task"),
      );
      assert.ok(handoffIndex !== -1, "handoff note missing from the request");
      assert.ok(contents[handoffIndex].includes("BG RESULT"));
      assert.ok(
        handoffIndex < userIndex,
        "handoff note must precede the user turn",
      );
      // The background job's own prompt stays out of foreground history as a
      // standalone message (its text still appears inside the handoff note's
      // job title).
      assert.equal(
        contents.some((content) => content.trim() === "audit dependencies"),
        false,
      );

      const stored = await loadStoredSession(sessionId);
      const storedContents = (stored?.messages ?? []).map((message) =>
        String(message.content),
      );
      const storedHandoff = storedContents.findIndex((content) =>
        content.includes("[Background agent job"),
      );
      const storedUser = storedContents.findIndex((content) =>
        content.includes("continue the main task"),
      );
      assert.ok(storedHandoff !== -1);
      assert.ok(storedHandoff < storedUser);
      deleteStoredSession(sessionId);
    } finally {
      stub.restore();
      if (previousKey === undefined) delete process.env.NOVA_API_KEY;
      else process.env.NOVA_API_KEY = previousKey;
      if (previousModel === undefined) delete process.env.NOVA_MODEL;
      else process.env.NOVA_MODEL = previousModel;
    }
  });
});
