import assert from "node:assert/strict";
import test from "node:test";
import type { ModelResponse } from "@datalabrotterdam/nova-sdk";
import {
  findModelMetadata,
  modelSupportsImageInput,
  resolveModelSupportsImageInput,
} from "../../src/core/model-capabilities.js";

test("image input is enabled only by explicit input capabilities", () => {
  assert.equal(modelSupportsImageInput({ capabilities: ["vision"] }), true);
  assert.equal(
    modelSupportsImageInput({ capabilities: ["Image-Input"] }),
    true,
  );
  assert.equal(
    modelSupportsImageInput({ capabilities: ["image_generation", "tools"] }),
    false,
  );
  assert.equal(modelSupportsImageInput(undefined), false);
});

test("model metadata can be resolved through an alias", () => {
  const model = {
    id: "provider/model-v1",
    aliases: ["model-latest"],
    capabilities: ["multimodal"],
  } as ModelResponse;
  assert.equal(findModelMetadata([model], "model-latest"), model);
});

test("model image support is resolved from the models endpoint", async () => {
  const model = {
    id: "vision-model",
    capabilities: ["input_image"],
  } as ModelResponse;
  const supported = await resolveModelSupportsImageInput(
    {
      models: {
        list: async () => ({ object: "list", data: [model] }),
      },
    } as never,
    "vision-model",
  );
  assert.equal(supported, true);
});
