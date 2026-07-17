export type PermissionRuleSet = {
  allow?: string[];
  deny?: string[];
};

export type PermissionDecision = "allow" | "deny" | "ask";

type PermissionTarget = {
  names: string[];
  value: string;
  path: boolean;
};

export function evaluatePermissionRules(
  rules: PermissionRuleSet | undefined,
  toolName: string,
  args: Record<string, unknown>,
): PermissionDecision {
  const target = permissionTarget(toolName, args);
  if (matchingRule(rules?.deny, target)) return "deny";
  if (matchingRule(rules?.allow, target)) return "allow";
  return "ask";
}

export function exactPermissionRule(
  toolName: string,
  args: Record<string, unknown>,
): string {
  const target = permissionTarget(toolName, args);
  const name = target.names[0] ?? toolName;
  const value = target.path
    ? escapePathGlob(normalizePath(target.value))
    : escapeGlob(target.value);
  return value ? `${name}(${value})` : name;
}

function matchingRule(
  rules: string[] | undefined,
  target: PermissionTarget,
): string | null {
  if (!Array.isArray(rules)) return null;
  for (const rule of rules) {
    const parsed = parseRule(rule);
    if (
      !parsed ||
      !target.names.some(
        (name) => name.toLowerCase() === parsed.name.toLowerCase(),
      )
    )
      continue;
    if (parsed.pattern === null) return rule;
    const pattern = target.path
      ? normalizePath(parsed.pattern)
      : parsed.pattern;
    const value = target.path ? normalizePath(target.value) : target.value;
    if (globMatches(pattern, value)) return rule;
  }
  return null;
}

function parseRule(
  rule: unknown,
): { name: string; pattern: string | null } | null {
  if (typeof rule !== "string") return null;
  const value = rule.trim();
  if (!value) return null;
  const open = value.indexOf("(");
  if (open < 0) return { name: value, pattern: null };
  if (!value.endsWith(")") || open === 0) return null;
  const name = value.slice(0, open).trim();
  return name ? { name, pattern: value.slice(open + 1, -1) } : null;
}

function permissionTarget(
  toolName: string,
  args: Record<string, unknown>,
): PermissionTarget {
  switch (toolName) {
    case "run_command":
    case "start_background_command":
      return {
        names: ["Bash", toolName],
        value: stringArg(args.command),
        path: false,
      };
    case "run_package_script": {
      const script = stringArg(args.script);
      const extra = Array.isArray(args.args)
        ? args.args.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      return {
        names: ["Bash", toolName],
        value: ["npm", "run", script, ...(extra.length ? ["--", ...extra] : [])]
          .filter(Boolean)
          .join(" "),
        path: false,
      };
    }
    case "write_file":
      return {
        names: ["Write", toolName],
        value: stringArg(args.path),
        path: true,
      };
    case "edit_file":
      return {
        names: ["Edit", toolName],
        value: stringArg(args.path),
        path: true,
      };
    default:
      return { names: [toolName], value: stableJson(args), path: false };
  }
}

function globMatches(pattern: string, value: string): boolean {
  let source = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    const literalGlob = pattern.slice(index, index + 3);
    if (literalGlob === "[*]" || literalGlob === "[?]") {
      source += escapeRegex(literalGlob[1]!);
      index += 2;
    } else if (
      character === "\\" &&
      (pattern[index + 1] === "*" || pattern[index + 1] === "?")
    ) {
      source += escapeRegex(pattern[++index]!);
    } else if (character === "*") {
      source += ".*";
    } else if (character === "?") {
      source += ".";
    } else {
      source += escapeRegex(character);
    }
  }
  return new RegExp(`${source}$`, process.platform === "win32" ? "i" : "").test(
    value,
  );
}

function escapeGlob(value: string): string {
  return value.replace(/[?*]/g, "\\$&");
}

function escapePathGlob(value: string): string {
  return value.replace(/\*/g, "[*]").replace(/\?/g, "[?]");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}

function stringArg(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stableJson(value: Record<string, unknown>): string {
  const sorted = Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
  return JSON.stringify(sorted);
}
