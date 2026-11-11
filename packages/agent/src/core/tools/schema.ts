export type ToolParamType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "array"
  | "object";

/**
 * The JSON Schema subset the harness understands. Unknown keywords are
 * dropped on import and never rejected: an exotic-but-valid schema must
 * degrade to "no opinion", not block args its own server would accept.
 */
export type ToolParamSchema = {
  type?: ToolParamType;
  description?: string;
  enum?: Array<string | number | boolean>;
  properties?: Record<string, ToolParamSchema>;
  required?: string[];
  items?: ToolParamSchema;
  additionalProperties?: boolean;
  default?: unknown;
};

/** Root schema for a tool's args object. */
export type ToolParameters = ToolParamSchema & { type: "object" };

export type ArgIssue = { path: string; message: string };

export type ArgValidationResult =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; issues: ArgIssue[] };

const PARAM_TYPES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "array",
  "object",
]);

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function matchesType(type: ToolParamType, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeOf(value) === "object";
  }
}

/**
 * Models frequently quote scalars ("100", "true"). Coerce the obvious
 * cases instead of burning a correction round on them.
 */
function coerce(type: ToolParamType, value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (type === "number" || type === "integer") {
    const trimmed = value.trim();
    if (trimmed === "") return value;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return value;
    if (type === "integer" && !Number.isInteger(parsed)) return value;
    return parsed;
  }
  if (type === "boolean") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return value;
}

function validateValue(
  schema: ToolParamSchema,
  value: unknown,
  path: string,
  issues: ArgIssue[],
): unknown {
  if (schema.enum && schema.enum.length > 0) {
    const coerced = schema.type ? coerce(schema.type, value) : value;
    if (!schema.enum.some((allowed) => allowed === coerced)) {
      issues.push({
        path,
        message: `"${path}" must be one of: ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`,
      });
      return value;
    }
    return coerced;
  }

  if (!schema.type) return value;

  const coerced = coerce(schema.type, value);
  if (!matchesType(schema.type, coerced)) {
    issues.push({
      path,
      message: `"${path}" must be ${schema.type === "integer" ? "an integer" : `a ${schema.type}`} (got ${typeOf(value)})`,
    });
    return value;
  }

  if (schema.type === "array" && schema.items && Array.isArray(coerced)) {
    return coerced.map((item, index) =>
      validateValue(schema.items as ToolParamSchema, item, `${path}[${index}]`, issues),
    );
  }

  if (schema.type === "object" && typeOf(coerced) === "object") {
    return validateObject(
      schema,
      coerced as Record<string, unknown>,
      path,
      issues,
    );
  }

  return coerced;
}

function validateObject(
  schema: ToolParamSchema,
  value: Record<string, unknown>,
  path: string,
  issues: ArgIssue[],
): Record<string, unknown> {
  const prefix = path ? `${path}.` : "";
  const result: Record<string, unknown> = { ...value };

  for (const name of schema.required ?? []) {
    if (value[name] === undefined) {
      issues.push({
        path: `${prefix}${name}`,
        message: `missing required "${prefix}${name}"`,
      });
    }
  }

  if (schema.properties) {
    for (const [name, propSchema] of Object.entries(schema.properties)) {
      if (value[name] === undefined) continue;
      result[name] = validateValue(propSchema, value[name], `${prefix}${name}`, issues);
    }
    if (schema.additionalProperties === false) {
      for (const name of Object.keys(value)) {
        if (!(name in schema.properties)) {
          issues.push({
            path: `${prefix}${name}`,
            message: `unknown argument "${prefix}${name}"`,
          });
        }
      }
    }
  }

  return result;
}

/**
 * Validate (and lightly coerce) tool args against a schema. Returns a
 * coerced shallow copy on success; the original args object is never
 * mutated.
 */
export function validateToolArgs(
  schema: ToolParameters,
  args: Record<string, unknown>,
): ArgValidationResult {
  const issues: ArgIssue[] = [];
  const coerced = validateObject(schema, args, "", issues);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, args: coerced };
}

const MAX_PROPERTY_DESCRIPTION = 80;
const MAX_DOC_LENGTH = 400;

function shorten(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1)}…`;
}

function renderPropertyDoc(name: string, schema: ToolParamSchema, required: boolean): string {
  const parts: string[] = [];
  if (schema.enum && schema.enum.length > 0) {
    parts.push(`one of ${schema.enum.map((v) => JSON.stringify(v)).join("|")}`);
  } else if (schema.type === "array" && schema.items?.type) {
    parts.push(`array of ${schema.items.type}`);
  } else {
    parts.push(schema.type ?? "any");
  }
  if (required) parts.push("required");
  if (schema.default !== undefined) parts.push(`default ${JSON.stringify(schema.default)}`);
  const description = schema.description
    ? ` — ${shorten(schema.description, MAX_PROPERTY_DESCRIPTION)}`
    : "";
  return `"${name}": <${parts.join(", ")}${description}>`;
}

/**
 * Compact one-line usage signature for the system prompt, e.g.
 * {"path": <string, required>, "max_matches": <integer, default 100>}
 */
export function renderParametersDoc(schema: ToolParameters): string {
  const required = new Set(schema.required ?? []);
  const entries = Object.entries(schema.properties ?? {}).map(([name, prop]) =>
    renderPropertyDoc(name, prop, required.has(name)),
  );
  if (entries.length === 0) return "{} (no arguments)";
  return shorten(`{${entries.join(", ")}}`, MAX_DOC_LENGTH);
}

function importSchema(raw: unknown): ToolParamSchema | undefined {
  if (typeOf(raw) !== "object") return undefined;
  const source = raw as Record<string, unknown>;
  const schema: ToolParamSchema = {};

  if (typeof source.type === "string" && PARAM_TYPES.has(source.type)) {
    schema.type = source.type as ToolParamType;
  }
  if (typeof source.description === "string") schema.description = source.description;
  if (Array.isArray(source.enum)) {
    const values = source.enum.filter(
      (v): v is string | number | boolean =>
        typeof v === "string" || typeof v === "number" || typeof v === "boolean",
    );
    if (values.length > 0 && values.length === source.enum.length) schema.enum = values;
  }
  if (Array.isArray(source.required)) {
    schema.required = source.required.filter((v): v is string => typeof v === "string");
  }
  if (typeOf(source.properties) === "object") {
    const properties: Record<string, ToolParamSchema> = {};
    for (const [name, raw] of Object.entries(source.properties as Record<string, unknown>)) {
      properties[name] = importSchema(raw) ?? {};
    }
    schema.properties = properties;
  }
  if (typeOf(source.items) === "object") {
    schema.items = importSchema(source.items);
  }
  if (source.additionalProperties === false) schema.additionalProperties = false;
  if (source.default !== undefined) schema.default = source.default;

  return schema;
}

/**
 * Lenient importer for an MCP tool's inputSchema. Keeps the supported
 * subset, drops unknown keywords, and returns undefined when the root is
 * not a usable object schema — validation is then skipped for that tool.
 */
export function toToolParameters(inputSchema: unknown): ToolParameters | undefined {
  if (typeOf(inputSchema) !== "object") return undefined;
  const root = inputSchema as Record<string, unknown>;
  if (root.type !== undefined && root.type !== "object") return undefined;
  if (root.type === undefined && typeOf(root.properties) !== "object") return undefined;
  const schema = importSchema(root);
  if (!schema) return undefined;
  return { ...schema, type: "object" };
}

/** Correction message fed back to the model when validation fails. */
export function formatArgIssues(
  toolName: string,
  issues: ArgIssue[],
  schema?: ToolParameters,
): string {
  const lines = [
    `Tool call "${toolName}" has invalid arguments: ${issues.map((i) => i.message).join("; ")}.`,
  ];
  if (schema) lines.push(`Expected args: ${renderParametersDoc(schema)}`);
  lines.push("Re-emit one corrected tool_call block with all required arguments inside \"args\".");
  return lines.join("\n");
}
