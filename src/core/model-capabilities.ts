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

export function modelSupportsImageInput(
  model: Pick<ModelResponse, "capabilities"> | null | undefined,
): boolean {
  return (model?.capabilities ?? []).some((capability) =>
    IMAGE_INPUT_CAPABILITIES.has(normalizeCapability(capability)),
  );
}

export function findModelMetadata(
  models: ModelResponse[],
  modelId: string,
): ModelResponse | undefined {
  return models.find(
    (model) => model.id === modelId || model.aliases?.includes(modelId),
  );
}

export async function resolveModelSupportsImageInput(
  client: Pick<NovaAI, "models">,
  modelId: string,
): Promise<boolean> {
  let after: string | undefined;
  do {
    const response = await client.models.list({
      limit: 100,
      ...(after ? { after } : {}),
    });
    const model = findModelMetadata(response.data, modelId);
    if (model) return modelSupportsImageInput(model);
    if (!response.has_more || !response.last_id || response.last_id === after) {
      return false;
    }
    after = response.last_id;
  } while (true);
}

function normalizeCapability(value: string): string {
  return value.trim().toLowerCase().replace(/[\s:-]+/g, "_");
}
