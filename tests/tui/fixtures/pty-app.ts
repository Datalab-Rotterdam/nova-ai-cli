import type * as acp from "@agentclientprotocol/sdk";
import type { ChatMessage } from "@datalabrotterdam/nova-sdk";
import { runPiTui } from "../../../src/tui/pi-app/app.js";
import { SessionRunner } from "../../../src/tui/session/session-runner.js";
import type { Store } from "../../../src/tui/state/store.js";
import type { UIMessage, UIState } from "../../../src/tui/state/types.js";
import { installFakeAgentQueue } from "../fake-agent-queue.js";

let fixtureMessageId = 0;

function appendAssistant(store: Store<UIState>, text: string): void {
  store.setState((state) => ({
    messages: [
      ...state.messages,
      {
        id: `fixture-assistant-${++fixtureMessageId}`,
        role: "assistant",
        text,
        streaming: false,
      },
    ],
  }));
}

function fillTranscript(store: Store<UIState>): void {
  const messages: UIMessage[] = Array.from({ length: 48 }, (_, index) => ({
    id: `fixture-fill-${index + 1}`,
    role: "assistant" as const,
    text: `fixture scroll line ${String(index + 1).padStart(2, "0")}`,
    streaming: false,
  }));
  store.setState({ messages });
}

function createFixtureRunner(store: Store<UIState>): SessionRunner {
  const runner = new SessionRunner(
    store,
    { apiKey: "pty-fixture", defaultModel: "fixture-model" },
    process.cwd(),
  );
  installFakeAgentQueue(runner);

  let releaseHold: (() => void) | null = null;
  let holdCancelled = false;
  const internals = runner as unknown as {
    ensureSession(): Promise<void>;
    agent: {
      prompt(
        params: acp.PromptRequest,
      ): Promise<{ stopReason: "end_turn" | "cancelled" }>;
      cancel(params: acp.CancelNotification): void;
    };
  };
  internals.ensureSession = async () => {};
  internals.agent.prompt = async (params) => {
    const text = params.prompt
      .filter(
        (block): block is Extract<acp.ContentBlock, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("\n");
    if (text.startsWith("hold ")) {
      holdCancelled = false;
      await new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
      releaseHold = null;
      if (holdCancelled) return { stopReason: "cancelled" };
    }
    appendAssistant(store, `fixture completed: ${text}`);
    return { stopReason: "end_turn" };
  };
  internals.agent.cancel = () => {
    holdCancelled = true;
    releaseHold?.();
  };

  const submit = runner.submit.bind(runner);
  runner.submit = async (text, images = [], pastes = []) => {
    if (text === "fixture-release") {
      releaseHold?.();
      return;
    }
    if (text === "fixture-fill") {
      fillTranscript(store);
      return;
    }
    await submit(text, images, pastes);
  };

  return runner;
}

await runPiTui(
  { apiKey: "pty-fixture", defaultModel: "fixture-model" },
  process.cwd(),
  [],
  {
    createRunner: createFixtureRunner,
    checkForUpdate: async () => null,
  },
);

// Let the parent PTY harness observe that the application itself completed
// terminal teardown before it closes the still-attached test process. Keeping
// the process attached avoids a node-pty ConPTY process-list race on Windows.
process.stdout.write("\nNOVA_PTY_FIXTURE_DONE\n");
if (process.env.NOVA_PTY_HOLD_OPEN === "1") {
  await new Promise<void>(() => setInterval(() => {}, 60_000));
}
