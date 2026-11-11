/**
 * Token and cost totals per session, the way the VS Code extension keeps them
 * (`usageTotals` of its chats; same shape, so imported chats keep counting).
 * Responses carry no cost: it is computed from the model's price per 1M
 * tokens in the gateway's model list, with cached tokens charged as input,
 * so it is an estimate. One currency per session (the last priced model's);
 * currencies are never converted.
 */
export type UsageTotals = {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cost?: number;
  currency?: string;
};

export type RequestUsage = { promptTokens: number; completionTokens: number; cachedTokens: number };

export type ModelPricing = { input?: number; output?: number; currency: string };

/** A model's price per 1M tokens (`inputCostPer1M`, `outputCostPer1M`, `currency`); undefined when it lists none. */
export function modelPricing(model: object | undefined): ModelPricing | undefined {
  if (!model) return undefined;
  const value = model as Record<string, unknown>;
  const first = (keys: string[]) => keys.map((key) => value[key]).find((entry) => typeof entry === "number") as number | undefined;
  const input = first(["inputCostPer1M", "input_cost_per_1m"]);
  const output = first(["outputCostPer1M", "output_cost_per_1m"]);
  if (input === undefined && output === undefined) return undefined;
  const currency = typeof value.currency === "string" && value.currency ? value.currency : "EUR";
  return { ...(input !== undefined ? { input } : {}), ...(output !== undefined ? { output } : {}), currency };
}

/** The usage of a streamed completion chunk (sent last with `stream_options.include_usage`). */
export function readUsage(data: { usage?: unknown }): RequestUsage | null {
  const usage = data.usage as
    | { prompt_tokens?: unknown; completion_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } }
    | null
    | undefined;
  if (!usage || typeof usage.prompt_tokens !== "number") return null;
  const cached = usage.prompt_tokens_details?.cached_tokens;
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
    cachedTokens: typeof cached === "number" ? cached : 0,
  };
}

/** One request added to the totals; the cost only when the model has a price. */
export function addUsage(totals: UsageTotals | undefined, usage: RequestUsage, pricing: ModelPricing | undefined): UsageTotals {
  const next: UsageTotals = {
    ...(totals ?? { promptTokens: 0, completionTokens: 0, cachedTokens: 0 }),
  };
  next.promptTokens += usage.promptTokens;
  next.completionTokens += usage.completionTokens;
  next.cachedTokens += usage.cachedTokens;
  if (pricing) {
    next.cost = (next.cost ?? 0) + (usage.promptTokens * (pricing.input ?? 0) + usage.completionTokens * (pricing.output ?? 0)) / 1_000_000;
    next.currency = pricing.currency;
  }
  return next;
}

/** Saved totals, when the value has their shape (session files, imported panel chats). */
export function parseUsageTotals(value: unknown): UsageTotals | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const count = (key: string) => (typeof v[key] === "number" && Number.isFinite(v[key]) ? (v[key] as number) : 0);
  if (typeof v.promptTokens !== "number") return undefined;
  return {
    promptTokens: count("promptTokens"),
    completionTokens: count("completionTokens"),
    cachedTokens: count("cachedTokens"),
    ...(typeof v.cost === "number" && Number.isFinite(v.cost) ? { cost: v.cost } : {}),
    ...(typeof v.currency === "string" && v.currency ? { currency: v.currency } : {}),
  };
}
