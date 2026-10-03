import assert from "node:assert/strict";
import test from "node:test";
import type { ModelResponse } from "@datalabrotterdam/nova-sdk";
import {
  chatModels,
  chooseDefaultModel,
  isChatModel,
  modelSupportsToolCalls,
  resolveDefaultModel,
} from "../../src/core/model-capabilities.js";

/** Shaped like a real Nova catalog: the embedding model comes first. */
const catalog = [
  ["bge-m3", ["embedding"]],
  ["gemma4:26b", ["function_calling", "text", "vision"]],
  ["gpt-4o-mini-tts", ["audio_synthesis"]],
  ["nemotron3.5-lightning:30b", ["function_calling", "reasoning", "text"]],
  ["plain-chat", ["text"]],
  ["whisper-large-v3-turbo", ["audio_transcription"]],
].map(
  ([id, capabilities]) =>
    ({ id, name: id, object: "model", created: 0, owned_by: "nova", capabilities }) as unknown as ModelResponse,
);

test("only text models count as chat models", () => {
  assert.deepEqual(
    chatModels(catalog).map((model) => model.id),
    ["gemma4:26b", "nemotron3.5-lightning:30b", "plain-chat"],
  );
  assert.equal(isChatModel({ capabilities: [] }), true, "no capability data: not ruled out");
  assert.equal(isChatModel({ capabilities: ["Function-Calling"] }), true);
  assert.equal(modelSupportsToolCalls({ capabilities: ["tools"] }), true);
  assert.equal(modelSupportsToolCalls({ capabilities: ["text"] }), false);
  assert.deepEqual(
    chatModels([{ ...catalog[1]!, enabled: false }]).map((model) => model.id),
    [],
    "disabled models are left out",
  );
});

test("the default model is the first chat model with tool calls, never an embedding model", () => {
  assert.equal(chooseDefaultModel(catalog), "gemma4:26b");
  assert.equal(chooseDefaultModel(catalog.filter((model) => model.id === "plain-chat" || model.id === "bge-m3")), "plain-chat");
  assert.equal(chooseDefaultModel(catalog.filter((model) => model.id === "bge-m3")), undefined);
});

test("a saved model is kept unless the catalog knows it cannot chat", () => {
  assert.equal(resolveDefaultModel(catalog, "bge-m3"), "gemma4:26b");
  assert.equal(resolveDefaultModel(catalog, "whisper-large-v3-turbo"), "gemma4:26b");
  assert.equal(resolveDefaultModel(catalog, "nemotron3.5-lightning:30b"), "nemotron3.5-lightning:30b");
  assert.equal(resolveDefaultModel(catalog, "some-alias-not-listed"), "some-alias-not-listed");
  assert.equal(resolveDefaultModel(catalog, undefined), "gemma4:26b");
  assert.equal(
    resolveDefaultModel(
      catalog.map((model) => (model.id === "plain-chat" ? { ...model, enabled: false } : model)),
      "plain-chat",
    ),
    "gemma4:26b",
    "a disabled model is replaced",
  );
  assert.equal(resolveDefaultModel([], "bge-m3"), "bge-m3", "nothing better: keep it");
});
