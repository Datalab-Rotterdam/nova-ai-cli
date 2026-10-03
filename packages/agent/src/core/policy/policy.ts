import type { ToolDefinition } from "../tools/types.js";
import { evaluatePermissionRules, exactPermissionRule } from "./rules.js";
import {
  addPrivateRule,
  loadPermissionRules,
  savedPermissionMode,
  savePermissionMode,
  type PermissionMode,
} from "./settings.js";

export type PolicyDecision =
  | { decision: "deny"; reason: "deny-rule" }
  | { decision: "allow"; reason: "read-only" | "allow-rule" | "session" | "mode" }
  | { decision: "ask" };

/** Tools that change what Nova knows in every later chat: always confirmed unless a rule allows them. */
const NEVER_AUTO_ACCEPTED = new Set(["memory_write"]);

/**
 * The agent's permission policy for one session. Every ACP client gets the
 * same behaviour (rules, modes, "always allow"), because the decision is made
 * here and clients only answer the questions the policy cannot.
 */
export class PermissionPolicy {
  private currentMode: PermissionMode;
  private readonly sessionRules = new Set<string>();

  constructor(
    readonly cwd: string,
    mode: PermissionMode = savedPermissionMode(cwd),
  ) {
    this.currentMode = mode;
  }

  get mode(): PermissionMode {
    return this.currentMode;
  }

  /** Changes the mode; default/acceptEdits are remembered for this workspace. */
  setMode(mode: PermissionMode, persist = true): void {
    this.currentMode = mode;
    if (persist) savePermissionMode(this.cwd, mode);
  }

  decide(
    tool: Pick<ToolDefinition, "name" | "mutating" | "kind">,
    args: Record<string, unknown>,
  ): PolicyDecision {
    // Rules are re-read for every call: the user may edit them mid-session.
    const rules = loadPermissionRules(this.cwd);
    const fromRules = evaluatePermissionRules(rules, tool.name, args, this.cwd);
    if (fromRules === "deny") return { decision: "deny", reason: "deny-rule" };
    if (!tool.mutating) return { decision: "allow", reason: "read-only" };
    if (fromRules === "allow") return { decision: "allow", reason: "allow-rule" };
    if (
      this.sessionRules.size &&
      evaluatePermissionRules({ allow: [...this.sessionRules] }, tool.name, args, this.cwd) ===
        "allow"
    ) {
      return { decision: "allow", reason: "session" };
    }
    if (NEVER_AUTO_ACCEPTED.has(tool.name)) return { decision: "ask" };
    if (this.currentMode === "bypassPermissions") {
      return { decision: "allow", reason: "mode" };
    }
    if (this.currentMode === "acceptEdits" && tool.kind === "edit") {
      return { decision: "allow", reason: "mode" };
    }
    return { decision: "ask" };
  }

  /** The exact rule "always allow" would save for this call. */
  ruleFor(tool: Pick<ToolDefinition, "name">, args: Record<string, unknown>): string {
    return exactPermissionRule(tool.name, args, this.cwd);
  }

  allowForSession(tool: Pick<ToolDefinition, "name">, args: Record<string, unknown>): void {
    this.sessionRules.add(this.ruleFor(tool, args));
  }

  /** Saves an exact allow rule in the private per-project settings; returns the rule. */
  allowAlways(tool: Pick<ToolDefinition, "name">, args: Record<string, unknown>): string {
    const rule = this.ruleFor(tool, args);
    addPrivateRule(this.cwd, "allow", rule);
    return rule;
  }
}
