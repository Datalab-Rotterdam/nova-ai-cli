import * as acp from "@agentclientprotocol/sdk";
import { NovaAI, type ModelResponse } from "@datalabrotterdam/nova-sdk";
import { createNovaClient } from "../core/nova-client.js";
import type { Session } from "../core/agent/session.js";
import { ToolSupportStore } from "../core/model/tool-support.js";
import { readCredentials, type StoredCredentials } from "../core/credentials.js";
import { resolveModelContextWindow } from "../core/context-compaction.js";
import {
  findModelMetadata,
  resolveDefaultModel,
  resolveEffort,
  resolveModelSupportsImageInput,
} from "../core/model-capabilities.js";
import {
  buildProviderInfos,
  listJoinedModels,
  type JoinedModel,
} from "./providers.js";

export const THOUGHT_LEVEL_CONFIG_ID = "thought_level";

const EFFORT_LABELS: Record<string, string> = {
  none: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/** "Off" / "On" for a model that only switches thinking, else the level's name. */
export function effortLabel(level: string, efforts: readonly string[]): string {
  if (efforts.length === 2 && efforts[0] === "none" && efforts[1] === "medium" && level === "medium") return "On";
  return EFFORT_LABELS[level] ?? level;
}

/** Model discovery, per-model capability caches and the providers/* surface. */
export class ModelService {
  /** Learned native tool-calling support per model, persisted across runs. */
  readonly toolSupport = new ToolSupportStore();
  private readonly imageSupportByModel = new Map<string, boolean>();
  private readonly contextWindowByModel = new Map<string, number>();
  private readonly disabledProviders = new Set<string>();
  private catalog: { apiKey: string; models: Promise<ModelResponse[]> } | null = null;

  /**
   * The model for a session that chose none (see resolveDefaultModel).
   * When the catalog can't be read, the saved default is used as is.
   */
  async defaultModel(
    credentials: StoredCredentials,
    preferred = credentials.defaultModel ?? process.env.NOVA_MODEL,
  ): Promise<string | undefined> {
    try {
      return resolveDefaultModel(await this.modelCatalog(credentials.apiKey), preferred);
    } catch {
      return preferred;
    }
  }

  private modelCatalog(apiKey: string): Promise<ModelResponse[]> {
    if (this.catalog?.apiKey !== apiKey) {
      const models = createNovaClient(apiKey)
        .models.list({ limit: 100 })
        .then((response) => response.data);
      // A failed lookup is retried next time instead of being cached.
      models.catch(() => {
        if (this.catalog?.models === models) this.catalog = null;
      });
      this.catalog = { apiKey, models };
    }
    return this.catalog.models;
  }

  /**
   * `_nova/models/list`: the chat models with what a client shows or checks
   * (context window, image input), and the model to use given the client's
   * `preferred` one (see resolveDefaultModel).
   */
  async listModels(
    preferred?: string,
  ): Promise<{ models: JoinedModel[]; defaultModel: string | null }> {
    const credentials = readCredentials();
    if (!credentials) throw acp.RequestError.authRequired();
    const models = await listJoinedModels(
      createNovaClient(credentials.apiKey),
      this.disabledProviders,
    );
    const defaultModel = await this.defaultModel(
      credentials,
      preferred ?? credentials.defaultModel ?? process.env.NOVA_MODEL,
    );
    return { models, defaultModel: defaultModel ?? null };
  }

  async buildConfigOptions(
    session: Session,
  ): Promise<acp.SessionConfigOption[]> {
    const credentials = readCredentials();
    if (!credentials) return [];
    let models: JoinedModel[];
    try {
      const novaClient = createNovaClient(credentials.apiKey);
      models = await listJoinedModels(novaClient, this.disabledProviders);
    } catch {
      // The model selector is supplementary info on fork/resume/set_config_option
      // responses; a transient discovery failure shouldn't fail the whole call.
      return [];
    }
    if (!models.length) return [];
    const currentModel =
      session.model ?? (await this.defaultModel(credentials)) ?? models[0].id;
    const current = models.find((m) => m.id === currentModel);
    const options: acp.SessionConfigOption[] = [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: currentModel,
        options: models.map((m) => ({
          value: m.id,
          name: m.label,
          ...(m.thinking ? { description: "Thinking model" } : {}),
        })),
      },
    ];
    if (current?.efforts.length) {
      options.push({
        id: THOUGHT_LEVEL_CONFIG_ID,
        name: "Thinking",
        category: "thought_level",
        type: "select",
        currentValue:
          resolveEffort(
            { reasoning_efforts: current.efforts, reasoning_default: current.reasoningDefault },
            session.effort,
          ) ?? current.efforts[0],
        options: current.efforts.map((level) => ({
          value: level,
          name: effortLabel(level, current.efforts),
        })),
      });
    }
    return options;
  }

  /**
   * The `reasoning_effort` to send for `model`: `chosen` when the model
   * accepts it, else its default (see resolveEffort). Undefined for a model
   * without levels, or when the catalog can't be read.
   */
  async effortFor(model: string, chosen: string | null): Promise<string | undefined> {
    const credentials = readCredentials();
    if (!credentials) return undefined;
    try {
      const catalog = await this.modelCatalog(credentials.apiKey);
      return resolveEffort(findModelMetadata(catalog, model), chosen);
    } catch {
      return undefined;
    }
  }

  async listProviders(): Promise<acp.ListProvidersResponse> {
    const credentials = readCredentials();
    if (!credentials) throw acp.RequestError.authRequired();
    const novaClient = createNovaClient(credentials.apiKey);
    const providers = await novaClient.providers.list();
    const models = await listJoinedModels(novaClient, this.disabledProviders);
    return {
      providers: buildProviderInfos(providers.data, this.disabledProviders),
      _meta: { "nova-ai-cli/models": models },
    };
  }

  async setProvider(
    params: acp.SetProviderRequest,
  ): Promise<acp.SetProviderResponse> {
    const credentials = readCredentials();
    if (!credentials) throw acp.RequestError.authRequired();
    const novaClient = createNovaClient(credentials.apiKey);
    const providers = await novaClient.providers.list();
    if (!providers.data.some((p) => p.id === params.id)) {
      throw acp.RequestError.invalidParams(
        params,
        `Unknown provider: ${params.id}`,
      );
    }
    this.disabledProviders.delete(params.id);
    return {};
  }

  disableProvider(
    params: acp.DisableProviderRequest,
  ): acp.DisableProviderResponse {
    this.disabledProviders.add(params.id);
    return {};
  }

  async resolveContextWindow(
    novaClient: NovaAI,
    model: string,
  ): Promise<number> {
    let window = this.contextWindowByModel.get(model);
    if (window === undefined) {
      window = await resolveModelContextWindow(novaClient, model);
      this.contextWindowByModel.set(model, window);
    }
    return window;
  }

  async assertImageInputSupported(
    novaClient: NovaAI,
    model: string,
    prompt: acp.PromptRequest["prompt"],
  ): Promise<void> {
    if (!prompt.some((block) => block.type === "image")) return;
    let supported = this.imageSupportByModel.get(model);
    if (supported === undefined) {
      supported = await resolveModelSupportsImageInput(novaClient, model);
      this.imageSupportByModel.set(model, supported);
    }
    if (!supported) {
      throw new Error(`Model ${model} does not support image input.`);
    }
  }
}
