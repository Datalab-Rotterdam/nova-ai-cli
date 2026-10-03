import * as acp from "@agentclientprotocol/sdk";
import { NovaAI } from "@datalabrotterdam/nova-sdk";
import type { Session } from "../core/agent/session.js";
import { readCredentials } from "../core/credentials.js";
import { resolveModelContextWindow } from "../core/context-compaction.js";
import { resolveModelSupportsImageInput } from "../core/model-capabilities.js";
import {
  buildProviderInfos,
  listJoinedModels,
  type JoinedModel,
} from "./providers.js";

/** Model discovery, per-model capability caches and the providers/* surface. */
export class ModelService {
  private readonly imageSupportByModel = new Map<string, boolean>();
  private readonly contextWindowByModel = new Map<string, number>();
  private readonly disabledProviders = new Set<string>();

  async buildConfigOptions(
    session: Session,
  ): Promise<acp.SessionConfigOption[]> {
    const credentials = readCredentials();
    if (!credentials) return [];
    let models: JoinedModel[];
    try {
      const novaClient = new NovaAI({ apiKey: credentials.apiKey });
      models = await listJoinedModels(novaClient, this.disabledProviders);
    } catch {
      // The model selector is supplementary info on fork/resume/set_config_option
      // responses; a transient discovery failure shouldn't fail the whole call.
      return [];
    }
    if (!models.length) return [];
    return [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: session.model ?? models[0].id,
        options: models.map((m) => ({ value: m.id, name: m.label })),
      },
    ];
  }

  async listProviders(): Promise<acp.ListProvidersResponse> {
    const credentials = readCredentials();
    if (!credentials) throw acp.RequestError.authRequired();
    const novaClient = new NovaAI({ apiKey: credentials.apiKey });
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
    const novaClient = new NovaAI({ apiKey: credentials.apiKey });
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
