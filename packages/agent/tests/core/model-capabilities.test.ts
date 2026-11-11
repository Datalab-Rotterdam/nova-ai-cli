import assert from "node:assert/strict";
import test from "node:test";
import type { ModelResponse } from "@datalabrotterdam/nova-sdk";
import {
  findModelMetadata,
  modelEfforts,
  modelSupportsImageInput,
  modelThinks,
  resolveEffort,
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
  } as unknown as ModelResponse;
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

test("thinking levels follow the gateway, with an off/on switch and a sensible default", () => {
  const leveled = { reasoning_efforts: ["low", "medium", "high"] };
  assert.deepEqual(modelEfforts(leveled), ["low", "medium", "high"]);
  assert.equal(resolveEffort(leveled, "high"), "high");
  assert.equal(resolveEffort(leveled, "xhigh"), "medium", "a level the model lacks falls back");
  assert.equal(resolveEffort({ reasoning_efforts: ["low", "high", "xhigh"] }), "high", "middle level without medium");

  const capabilityOnly = { capabilities: ["Reasoning"] };
  assert.deepEqual(modelEfforts(capabilityOnly), ["none", "medium"]);
  assert.equal(resolveEffort(capabilityOnly), "medium");
  assert.equal(resolveEffort({ ...capabilityOnly, reasoning_default: "off" as const }), "none");

  const fixedDepth = { reasoning_default: "on" as const };
  assert.deepEqual(modelEfforts(fixedDepth), []);
  assert.equal(modelThinks(fixedDepth), true);
  assert.equal(resolveEffort(fixedDepth, "high"), undefined);

  assert.equal(modelThinks({ capabilities: ["tools"] }), false);
});
