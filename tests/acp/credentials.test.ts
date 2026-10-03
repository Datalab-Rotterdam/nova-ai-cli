import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  credentialsPath,
  readCredentials,
  readStoredCredentials,
  saveDefaultModel,
  writeCredentials,
} from "../../src/acp/credentials.js";

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

describe("credentials file", () => {
  const original = {
    home: process.env.NOVA_AI_HOME,
    apiKey: process.env.NOVA_API_KEY,
    model: process.env.NOVA_MODEL,
  };
  let home: string;
  const posix = process.platform !== "win32";
  const mode = (path: string) => statSync(path).mode & 0o777;

  beforeEach(() => {
    home = join(mkdtempSync(join(tmpdir(), "nova-cred-test-")), "nova-home");
    process.env.NOVA_AI_HOME = home;
    delete process.env.NOVA_API_KEY;
    delete process.env.NOVA_MODEL;
  });

  afterEach(() => {
    rmSync(join(home, ".."), { recursive: true, force: true });
    for (const [key, value] of [
      ["NOVA_AI_HOME", original.home],
      ["NOVA_API_KEY", original.apiKey],
      ["NOVA_MODEL", original.model],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("resolves under NOVA_AI_HOME", () => {
    assert.equal(credentialsPath(), join(home, "credentials.json"));
  });

  it("writes owner-only files in an owner-only directory", { skip: !posix }, () => {
    writeCredentials({ apiKey: "k", defaultModel: "m" });
    assert.equal(mode(home), 0o700);
    assert.equal(mode(credentialsPath()), 0o600);
    assert.deepEqual(readStoredCredentials(), { apiKey: "k", defaultModel: "m" });
  });

  it("tightens an existing world-readable file on rewrite", { skip: !posix }, () => {
    writeCredentials({ apiKey: "old" });
    chmodSync(credentialsPath(), 0o644);
    writeCredentials({ apiKey: "new" });
    assert.equal(mode(credentialsPath()), 0o600);
    assert.equal(readStoredCredentials()?.apiKey, "new");
  });

  it("ignores malformed or incomplete files", () => {
    writeCredentials({ apiKey: "k" });
    for (const content of ["not json", "[]", "{}", '{"apiKey": ""}', '{"apiKey": 3}']) {
      writeFileSync(credentialsPath(), content);
      assert.equal(readCredentials(), null, content);
    }
    writeFileSync(credentialsPath(), '{"apiKey": "k", "defaultModel": 5}');
    assert.deepEqual(readCredentials(), { apiKey: "k", defaultModel: undefined });
  });

  it("never copies an env-provided key to disk when saving the model", () => {
    process.env.NOVA_API_KEY = "env-secret";
    assert.equal(saveDefaultModel("model-b"), false);
    assert.equal(existsSync(credentialsPath()), false);
  });

  it("updates only the model of the stored key", () => {
    writeCredentials({ apiKey: "file-key", defaultModel: "model-a" });
    process.env.NOVA_API_KEY = "env-secret";
    assert.equal(saveDefaultModel("model-b"), true);
    const saved = JSON.parse(readFileSync(credentialsPath(), "utf8"));
    assert.deepEqual(saved, { apiKey: "file-key", defaultModel: "model-b" });
  });
});
