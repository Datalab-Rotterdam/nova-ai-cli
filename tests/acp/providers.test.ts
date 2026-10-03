import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NovaAI } from "@datalabrotterdam/nova-sdk";
import { buildProviderInfos, listJoinedModels } from "../../src/acp/providers.js";

function fakeNovaClient(): NovaAI {
  return {
    providers: {
      list: async () => ({
        object: "list" as const,
        data: [
          { id: "nova-main", object: "provider" as const, name: "Nova" },
          { id: "openai", object: "provider" as const, name: "OpenAI" },
        ],
      }),
    },
    models: {
      list: async () => ({
        object: "list" as const,
        data: [
          {
            id: "qwen3.6:27b",
            object: "model" as const,
            created: 0,
            owned_by: "nova-main",
            name: "Qwen 3.6",
            enabled: true,
          },
          {
            id: "gpt-5",
            object: "model" as const,
            created: 0,
            owned_by: "openai",
            name: "GPT-5",
            enabled: true,
          },
          {
            id: "disabled-model",
            object: "model" as const,
            created: 0,
            owned_by: "openai",
            enabled: false,
          },
        ],
      }),
    },
  } as unknown as NovaAI;
}

describe("listJoinedModels", () => {
  it("joins models to providers and formats the label", async () => {
    const models = await listJoinedModels(fakeNovaClient(), new Set());
    assert.deepEqual(
      models.map((m) => m.label),
      ["Qwen 3.6 (qwen3.6:27b) [Nova]", "GPT-5 (gpt-5) [OpenAI]"],
    );
  });

  it("filters out models with enabled: false", async () => {
    const models = await listJoinedModels(fakeNovaClient(), new Set());
    assert.equal(
      models.some((m) => m.id === "disabled-model"),
      false,
    );
  });

  it("marks a model's enabled flag false when its provider is disabled", async () => {
    const models = await listJoinedModels(
      fakeNovaClient(),
      new Set(["openai"]),
    );
    const gpt = models.find((m) => m.id === "gpt-5");
    const qwen = models.find((m) => m.id === "qwen3.6:27b");
    assert.equal(gpt?.enabled, false);
    assert.equal(qwen?.enabled, true);
  });
});

describe("buildProviderInfos", () => {
  it("reports current: null only for disabled providers", () => {
    const infos = buildProviderInfos(
      [
        { id: "nova-main", object: "provider" as const, name: "Nova" },
        { id: "openai", object: "provider" as const, name: "OpenAI" },
      ],
      new Set(["openai"]),
    );
    assert.equal(infos.find((p) => p.id === "openai")?.current, null);
    assert.notEqual(infos.find((p) => p.id === "nova-main")?.current, null);
  });
});
