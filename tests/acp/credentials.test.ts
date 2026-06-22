import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { readCredentials } from "../../src/acp/credentials.js";

// credentials.ts resolves its file path from homedir() at module-load time,
// so these tests stick to the env-var path rather than overriding HOME
// (which would not take effect, and risks touching the real ~/.nova-ai).
describe("readCredentials", () => {
  const originalApiKey = process.env.NOVA_API_KEY;
  const originalModel = process.env.NOVA_MODEL;

  beforeEach(() => {
    delete process.env.NOVA_API_KEY;
    delete process.env.NOVA_MODEL;
  });

  afterEach(() => {
    if (originalApiKey === undefined) delete process.env.NOVA_API_KEY;
    else process.env.NOVA_API_KEY = originalApiKey;
    if (originalModel === undefined) delete process.env.NOVA_MODEL;
    else process.env.NOVA_MODEL = originalModel;
  });

  it("prefers NOVA_API_KEY env var, with NOVA_MODEL as the default model", () => {
    process.env.NOVA_API_KEY = "env-key";
    process.env.NOVA_MODEL = "env-model";
    assert.deepEqual(readCredentials(), { apiKey: "env-key", defaultModel: "env-model" });
  });

  it("returns defaultModel as undefined when NOVA_MODEL is unset", () => {
    process.env.NOVA_API_KEY = "env-key";
    assert.deepEqual(readCredentials(), { apiKey: "env-key", defaultModel: undefined });
  });
});
