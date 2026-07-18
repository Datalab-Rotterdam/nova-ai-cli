import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatArgIssues,
  renderParametersDoc,
  toToolParameters,
  validateToolArgs,
  type ToolParameters,
} from "../../../src/acp/tools/schema.js";

const editFileSchema: ToolParameters = {
  type: "object",
  properties: {
    path: { type: "string", description: "absolute path" },
    old_string: { type: "string" },
    new_string: { type: "string" },
  },
  required: ["path", "old_string", "new_string"],
};

describe("validateToolArgs", () => {
  it("accepts valid args and returns a copy", () => {
    const args = { path: "/a", old_string: "x", new_string: "y" };
    const result = validateToolArgs(editFileSchema, args);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.deepEqual(result.args, args);
      assert.notEqual(result.args, args);
    }
  });

  it("reports every missing required argument", () => {
    const result = validateToolArgs(editFileSchema, { path: "/a" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.deepEqual(
        result.issues.map((i) => i.path).sort(),
        ["new_string", "old_string"],
      );
      assert.match(result.issues[0].message, /missing required/);
    }
  });

  it("reports type mismatches with the observed type", () => {
    const result = validateToolArgs(editFileSchema, {
      path: 42,
      old_string: "x",
      new_string: "y",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.issues.length, 1);
      assert.match(result.issues[0].message, /"path" must be a string \(got number\)/);
    }
  });

  it("coerces quoted numbers and booleans", () => {
    const schema: ToolParameters = {
      type: "object",
      properties: {
        max: { type: "integer" },
        ratio: { type: "number" },
        deep: { type: "boolean" },
      },
    };
    const result = validateToolArgs(schema, { max: "5", ratio: "0.5", deep: "true" });
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.args, { max: 5, ratio: 0.5, deep: true });
  });

  it("does not coerce non-numeric strings", () => {
    const schema: ToolParameters = {
      type: "object",
      properties: { max: { type: "integer" } },
    };
    const result = validateToolArgs(schema, { max: "5x" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.issues[0].message, /must be an integer/);
  });

  it("rejects a float for an integer property", () => {
    const schema: ToolParameters = {
      type: "object",
      properties: { max: { type: "integer" } },
    };
    const result = validateToolArgs(schema, { max: 1.5 });
    assert.equal(result.ok, false);
  });

  it("enforces enum membership", () => {
    const schema: ToolParameters = {
      type: "object",
      properties: { mode: { type: "string", enum: ["fast", "slow"] } },
    };
    assert.equal(validateToolArgs(schema, { mode: "fast" }).ok, true);
    const bad = validateToolArgs(schema, { mode: "medium" });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.match(bad.issues[0].message, /one of: "fast", "slow"/);
  });

  it("validates nested array items", () => {
    const schema: ToolParameters = {
      type: "object",
      properties: {
        items: { type: "array", items: { type: "integer" } },
      },
    };
    const good = validateToolArgs(schema, { items: [1, "2", 3] });
    assert.equal(good.ok, true);
    if (good.ok) assert.deepEqual(good.args.items, [1, 2, 3]);

    const bad = validateToolArgs(schema, { items: [1, "x"] });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.issues[0].path, "items[1]");
  });

  it("validates nested object properties", () => {
    const schema: ToolParameters = {
      type: "object",
      properties: {
        options: {
          type: "object",
          properties: { depth: { type: "integer" } },
          required: ["depth"],
        },
      },
    };
    const bad = validateToolArgs(schema, { options: {} });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.issues[0].path, "options.depth");
  });

  it("rejects unknown keys only when additionalProperties is false", () => {
    const closed: ToolParameters = {
      type: "object",
      properties: { a: { type: "string" } },
      additionalProperties: false,
    };
    const open: ToolParameters = {
      type: "object",
      properties: { a: { type: "string" } },
    };
    assert.equal(validateToolArgs(open, { a: "x", extra: 1 }).ok, true);
    const bad = validateToolArgs(closed, { a: "x", extra: 1 });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.match(bad.issues[0].message, /unknown argument "extra"/);
  });

  it("accepts properties without a recognized type as-is", () => {
    const schema: ToolParameters = {
      type: "object",
      properties: { anything: {} },
      required: ["anything"],
    };
    assert.equal(validateToolArgs(schema, { anything: { nested: true } }).ok, true);
  });
});

describe("toToolParameters", () => {
  it("imports a realistic MCP schema keeping required intact", () => {
    const params = toToolParameters({
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to the file" },
        max_lines: { type: "integer", default: 100 },
      },
      required: ["file_path"],
      $schema: "http://json-schema.org/draft-07/schema#",
    });
    assert.ok(params);
    assert.deepEqual(params?.required, ["file_path"]);
    assert.equal(params?.properties?.file_path.type, "string");
    assert.equal(params?.properties?.max_lines.default, 100);
  });

  it("drops unknown keywords instead of failing", () => {
    const params = toToolParameters({
      type: "object",
      properties: {
        query: { type: "string", pattern: "^.+$", minLength: 1 },
      },
    });
    assert.ok(params);
    assert.deepEqual(params?.properties?.query, { type: "string" });
  });

  it("returns undefined for a non-object root schema", () => {
    assert.equal(toToolParameters({ oneOf: [{ type: "string" }] }), undefined);
    assert.equal(toToolParameters({ type: "string" }), undefined);
    assert.equal(toToolParameters("garbage"), undefined);
    assert.equal(toToolParameters(null), undefined);
  });

  it("accepts a schema with properties but no explicit type", () => {
    const params = toToolParameters({
      properties: { a: { type: "string" } },
    });
    assert.equal(params?.type, "object");
    assert.equal(params?.properties?.a.type, "string");
  });
});

describe("renderParametersDoc", () => {
  it("renders types, required flags, defaults, and descriptions", () => {
    const doc = renderParametersDoc({
      type: "object",
      properties: {
        path: { type: "string", description: "absolute path" },
        max: { type: "integer", default: 100 },
        mode: { type: "string", enum: ["fast", "slow"] },
      },
      required: ["path"],
    });
    assert.match(doc, /"path": <string, required — absolute path>/);
    assert.match(doc, /"max": <integer, default 100>/);
    assert.match(doc, /"mode": <one of "fast"\|"slow">/);
  });

  it("renders an empty schema as no arguments", () => {
    assert.equal(
      renderParametersDoc({ type: "object", properties: {} }),
      "{} (no arguments)",
    );
  });

  it("caps the total length", () => {
    const properties: Record<string, { type: "string"; description: string }> = {};
    for (let i = 0; i < 40; i++) {
      properties[`property_${i}`] = { type: "string", description: "x".repeat(120) };
    }
    const doc = renderParametersDoc({ type: "object", properties });
    assert.ok(doc.length <= 400);
    assert.ok(doc.endsWith("…"));
  });
});

describe("formatArgIssues", () => {
  it("lists issues and the expected signature", () => {
    const result = validateToolArgs(editFileSchema, { path: "/a" });
    assert.equal(result.ok, false);
    if (!result.ok) {
      const message = formatArgIssues("edit_file", result.issues, editFileSchema);
      assert.match(message, /Tool call "edit_file" has invalid arguments/);
      assert.match(message, /missing required "old_string"/);
      assert.match(message, /Expected args: \{"path": <string, required/);
      assert.match(message, /Re-emit one corrected tool_call block/);
    }
  });
});
