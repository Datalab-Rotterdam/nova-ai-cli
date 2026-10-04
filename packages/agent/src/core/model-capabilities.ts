import type { ModelResponse, NovaAI } from "@datalabrotterdam/nova-sdk";

const IMAGE_INPUT_CAPABILITIES = new Set([
  "image",
  "images",
  "image_input",
  "input_image",
  "vision",
  "multimodal",
  "multimodal_input",
]);

const TOOL_CALL_CAPABILITIES = new Set([
  "function_calling",
  "functions",
  "tools",
  "tool_calling",
  "tool_calls",
  "tool_use",
]);

const TEXT_CAPABILITIES = new Set([
  "text",
  "chat",
  "completion",
  "completions",
  "chat_completion",
  "chat_completions",
  ...TOOL_CALL_CAPABILITIES,
]);

/** Native function calling (the agent falls back to its text protocol otherwise). */
export function modelSupportsToolCalls(
  model: Pick<ModelResponse, "capabilities"> | null | undefined,
): boolean {
  return (model?.capabilities ?? []).some((capability) =>
    TOOL_CALL_CAPABILITIES.has(normalizeCapability(capability)),
  );
}

/**
 * Whether the model can drive a chat: it produces text. Embedding, speech
 * and transcription models cannot. A model without capability data counts
 * as usable, since nothing says otherwise.
 */
export function isChatModel(
  model: Pick<ModelResponse, "capabilities"> | null | undefined,
): boolean {
  const capabilities = model?.capabilities;
  if (!Array.isArray(capabilities) || capabilities.length === 0) return true;
  return capabilities.some((capability) =>
    TEXT_CAPABILITIES.has(normalizeCapability(capability)),
  );
}

/** Enabled chat models, in the gateway's order. */
export function chatModels<T extends Pick<ModelResponse, "capabilities"> & { enabled?: boolean }>(
  models: T[],
): T[] {
  return models.filter((model) => model.enabled !== false && isChatModel(model));
}

/** The best chat model: the first with native tool calls, else the first one. */
export function chooseDefaultModel(models: ModelResponse[]): string | undefined {
  const usable = chatModels(models);
  return (usable.find(modelSupportsToolCalls) ?? usable[0])?.id;
}

/**
 * The model to use when a session chose none. `preferred` (the saved default
 * or NOVA_MODEL) wins unless the catalog knows it cannot chat or is disabled:
 * older logins saved the first model of the list, which could be an
 * embedding model. An id the catalog does not list (an alias, a model behind
 * a later page) is kept.
 */
export function resolveDefaultModel(
  models: ModelResponse[],
  preferred: string | null | undefined,
): string | undefined {
  if (preferred) {
    const known = findModelMetadata(models, preferred);
    if (!known || (known.enabled !== false && isChatModel(known))) return preferred;
  }
  return chooseDefaultModel(models) ?? preferred ?? undefined;
}

export function modelSupportsImageInput(
  model: Pick<ModelResponse, "capabilities"> | null | undefined,
): boolean {
  return (model?.capabilities ?? []).some((capability) =>
    IMAGE_INPUT_CAPABILITIES.has(normalizeCapability(capability)),
  );
}

/**
 * The model's context window in tokens, or null when the gateway does not
 * say. Nova's gateway sends `contextWindow`; OpenAI-compatible servers use
 * `context_window` or `max_model_len`.
 */
export function modelContextWindow(model: object | null | undefined): number | null {
  return positiveNumber(model, ["contextWindow", "context_window", "max_model_len"]);
}

/** Most tokens the model may generate in one answer, or null when unknown. */
export function modelMaxOutputTokens(model: object | null | undefined): number | null {
  return positiveNumber(model, ["maxOutputTokens", "max_output_tokens"]);
}

function positiveNumber(model: object | null | undefined, keys: string[]): number | null {
  if (!model) return null;
  for (const key of keys) {
    const value = (model as Record<string, unknown>)[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

export function findModelMetadata(
  models: ModelResponse[],
  modelId: string,
): ModelResponse | undefined {
  return models.find(
    (model) => model.id === modelId || model.aliases?.includes(modelId),
  );
}

/** Paginates the models endpoint until the requested model is found. */
export async function resolveModelMetadata(
  client: Pick<NovaAI, "models">,
  modelId: string,
): Promise<ModelResponse | undefined> {
  let after: string | undefined;
  do {
    const response = await client.models.list({
      limit: 100,
      ...(after ? { after } : {}),
    });
    const model = findModelMetadata(response.data, modelId);
    if (model) return model;
    if (!response.has_more || !response.last_id || response.last_id === after) {
      return undefined;
    }
    after = response.last_id;
  } while (true);
}

export async function resolveModelSupportsImageInput(
  client: Pick<NovaAI, "models">,
  modelId: string,
): Promise<boolean> {
  return modelSupportsImageInput(await resolveModelMetadata(client, modelId));
}

function normalizeCapability(value: string): string {
  return value.trim().toLowerCase().replace(/[\s:-]+/g, "_");
}
