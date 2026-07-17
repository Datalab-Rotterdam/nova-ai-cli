import type * as acp from "@agentclientprotocol/sdk";
import type { NovaAI, ProviderResponse } from "@datalabrotterdam/nova-sdk";

export type JoinedModel = {
  id: string;
  label: string;
  providerId: string;
  providerName: string;
  enabled: boolean;
};

export async function listJoinedModels(
  novaClient: NovaAI,
  disabledProviderIds: ReadonlySet<string>,
): Promise<JoinedModel[]> {
  const [providers, models] = await Promise.all([
    novaClient.providers.list(),
    novaClient.models.list(),
  ]);
  const providerById = new Map(providers.data.map((p) => [p.id, p]));
  return models.data
    .filter((m) => m.enabled !== false)
    .map((m) => {
      const provider = providerById.get(m.owned_by);
      const providerName = provider?.name ?? m.owned_by;
      return {
        id: m.id,
        label: `${m.name ?? m.id} (${m.id}) [${providerName}]`,
        providerId: m.owned_by,
        providerName,
        enabled: !disabledProviderIds.has(m.owned_by),
      };
    });
}

/**
 * Nova is a unified gateway with no per-provider endpoint config to expose,
 * so `current` is only used to signal disabled/enabled state, not a real
 * apiType/baseUrl routing config.
 */
export function buildProviderInfos(
  providers: ProviderResponse[],
  disabled: ReadonlySet<string>,
): acp.ProviderInfo[] {
  return providers.map((p) => ({
    id: p.id,
    supported: [],
    required: false,
    current: disabled.has(p.id) ? null : { apiType: "openai", baseUrl: "" },
  }));
}
