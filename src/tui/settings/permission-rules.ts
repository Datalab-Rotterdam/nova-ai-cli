export type PermissionRuleSet = {
  allow?: string[];
  deny?: string[];
};

export type PermissionDecision = "allow" | "deny" | "ask";

type PermissionTarget = {
  names: string[];
  value: string;
  path: boolean;
  shell: boolean;
};

export type ShellCommandAnalysis = {
  segments: string[];
  /**
   * Complex shell syntax can hide additional execution inside a single
   * apparent segment. Broad allow rules must not approve it automatically;
   * only an exact, argument-aware rule may do so.
   */
  complex: boolean;
};

export function evaluatePermissionRules(
  rules: PermissionRuleSet | undefined,
  toolName: string,
  args: Record<string, unknown>,
): PermissionDecision {
  const target = permissionTarget(toolName, args);
  if (!target.shell) {
    if (matchingRule(rules?.deny, target)) return "deny";
    if (matchingRule(rules?.allow, target)) return "allow";
    return "ask";
  }

  const analysis = analyzeShellCommand(target.value);
  const segmentTargets = analysis.segments.map((value) => ({
    ...target,
    value,
  }));

  // A deny applies to the submitted command as well as every executable
  // segment. This prevents a safe-looking prefix from hiding a denied suffix.
  if (
    matchingRule(rules?.deny, target) ||
    segmentTargets.some((segment) => matchingRule(rules?.deny, segment))
  ) {
    return "deny";
  }

  const exactWholeCommand = matchingExactRule(rules?.allow, target);
  if (exactWholeCommand) return "allow";

  // Empty or syntactically complex input cannot be authorized by a broad
  // rule. Complex input includes nested shells, substitutions, grouping,
  // heredocs, and malformed quoting; the user can still persist an exact rule
  // after reviewing that specific invocation.
  if (analysis.complex || segmentTargets.length === 0) return "ask";

  if (segmentTargets.every((segment) => matchingRule(rules?.allow, segment))) {
    return "allow";
  }
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

function matchingExactRule(
  rules: string[] | undefined,
  target: PermissionTarget,
): string | null {
  if (!Array.isArray(rules)) return null;
  for (const rule of rules) {
    const parsed = parseRule(rule);
    if (
      !parsed ||
      parsed.pattern === null ||
      !target.names.some(
        (name) => name.toLowerCase() === parsed.name.toLowerCase(),
      )
    ) {
      continue;
    }
    const literal = literalGlobValue(parsed.pattern);
    if (literal !== null && literal === target.value) return rule;
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
        shell: true,
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
        shell: true,
      };
    }
    case "write_file":
      return {
        names: ["Write", toolName],
        value: stringArg(args.path),
        path: true,
        shell: false,
      };
    case "edit_file":
      return {
        names: ["Edit", toolName],
        value: stringArg(args.path),
        path: true,
        shell: false,
      };
    default:
      return {
        names: [toolName],
        value: stableJson(args),
        path: false,
        shell: false,
      };
  }
}

/**
 * Split a shell command at top-level execution operators without interpreting
 * operators inside ordinary quoted strings. The parser intentionally fails
 * closed for constructs whose contents may execute independently.
 *
 * This is a permission parser, not a shell parser: marking a command complex
 * is safe because it only disables broad auto-approval and falls back to an
 * interactive decision.
 */
export function analyzeShellCommand(command: string): ShellCommandAnalysis {
  const segments: string[] = [];
  let current = "";
  let quote: "single" | "double" | null = null;
  let complex = false;

  const push = () => {
    const value = current.trim();
    if (value) segments.push(value);
    current = "";
  };

  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    const next = command[index + 1] ?? "";
    const previous = command[index - 1] ?? "";

    if (quote === "single") {
      current += character;
      if (character === "'") {
        // PowerShell represents a literal single quote as ''. POSIX closes and
        // immediately reopens it; either way it is not an execution boundary.
        if (next === "'") current += command[++index]!;
        else quote = null;
      }
      continue;
    }

    if (quote === "double") {
      current += character;
      if (character === "\\" && next) {
        current += command[++index]!;
        continue;
      }
      // Command substitution executes even inside double quotes in POSIX and
      // PowerShell shells, so broad prefix approval is not sufficient.
      if (character === "$" && next === "(") complex = true;
      if (character === "`") complex = true;
      if (character === '"') quote = null;
      continue;
    }

    if (character === "'") {
      quote = "single";
      current += character;
      continue;
    }
    if (character === '"') {
      quote = "double";
      current += character;
      continue;
    }
    if (character === "\\" && next) {
      current += character + command[++index]!;
      continue;
    }
    if (character === "`" || (character === "$" && next === "(")) {
      complex = true;
      current += character;
      continue;
    }
    if (
      character === "(" ||
      character === ")" ||
      character === "{" ||
      character === "}" ||
      (character === "<" && next === "<") ||
      (character === "<" && next === "(")
    ) {
      complex = true;
      current += character;
      continue;
    }

    const twoCharacterOperator =
      (character === "&" && next === "&") ||
      (character === "|" && next === "|");
    const singleCharacterOperator =
      character === ";" ||
      character === "\n" ||
      character === "\r" ||
      character === "|" ||
      (character === "&" && previous !== ">" && previous !== "<");

    if (twoCharacterOperator) {
      push();
      index++;
      continue;
    }
    if (singleCharacterOperator) {
      push();
      // Treat CRLF as a single boundary.
      if (character === "\r" && next === "\n") index++;
      continue;
    }

    current += character;
  }

  if (quote !== null) complex = true;
  push();

  if (segments.some(isNestedShellOrControlSegment)) complex = true;
  return { segments, complex };
}

function isNestedShellOrControlSegment(segment: string): boolean {
  const normalized = segment.trimStart().toLowerCase();
  return /^(?:cmd(?:\.exe)?\s+\/(?:c|k)\b|(?:powershell|pwsh)(?:\.exe)?\b[^\r\n]*\s-(?:command|encodedcommand)\b|(?:ba|z|k|c|fi)?sh\s+-c\b|(?:if|for|foreach|while|until|case|function|try|do)\b)/i.test(
    normalized,
  );
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

/** Return the literal represented by a wildcard-free glob, or null. */
function literalGlobValue(pattern: string): string | null {
  let result = "";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    const next = pattern[index + 1];
    if (character === "\\" && (next === "*" || next === "?")) {
      result += next;
      index++;
    } else if (character === "*" || character === "?") {
      return null;
    } else {
      result += character;
    }
  }
  return result;
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
