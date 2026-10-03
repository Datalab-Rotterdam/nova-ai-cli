import { nativeToolCalls } from "../history.js";
import {
  ToolCallingUnsupportedError,
  type ToolSupport,
} from "../model/tool-support.js";
import type { RunTurnResult } from "../run-turn.js";

export type ToolProtocol = "native" | "text";

export type ToolSupportLookup = {
  get(model: string): ToolSupport;
  set(model: string, support: Exclude<ToolSupport, "unknown">): void;
};

/** `NOVA_TOOL_PROTOCOL=text|native` forces a protocol (escape hatch). */
export function forcedToolProtocol(): ToolProtocol | null {
  const value = process.env.NOVA_TOOL_PROTOCOL?.trim().toLowerCase();
  return value === "native" || value === "text" ? value : null;
}

export function chooseToolProtocol(
  model: string,
  support: ToolSupportLookup,
  hasTools: boolean,
): ToolProtocol {
  if (!hasTools) return "text";
  const forced = forcedToolProtocol();
  if (forced) return forced;
  return support.get(model) === "unsupported" ? "text" : "native";
}

/**
 * Runs one turn with the protocol the model supports. `run` must build the
 * system prompt for the protocol it is given. When the server rejects native
 * tools (detected before the turn touched history), the model is remembered
 * as unsupported and the turn is retried once with the text protocol. A
 * native turn that actually produced tool calls marks the model supported.
 */
export async function runWithToolProtocol(options: {
  model: string;
  support: ToolSupportLookup;
  hasTools: boolean;
  run(protocol: ToolProtocol): Promise<RunTurnResult>;
}): Promise<RunTurnResult> {
  const protocol = chooseToolProtocol(
    options.model,
    options.support,
    options.hasTools,
  );
  if (protocol === "text") return options.run("text");

  try {
    const result = await options.run("native");
    if (result.turnMessages.some((message) => nativeToolCalls(message).length)) {
      options.support.set(options.model, "supported");
    }
    return result;
  } catch (error) {
    if (!(error instanceof ToolCallingUnsupportedError)) throw error;
    if (forcedToolProtocol() !== "native") {
      options.support.set(options.model, "unsupported");
    }
    return options.run("text");
  }
}
