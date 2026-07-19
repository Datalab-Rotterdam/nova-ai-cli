import type * as acp from "@agentclientprotocol/sdk";
import type { ToolDefinition } from "./types.js";

const PLAN_STATUSES = ["pending", "in_progress", "completed"] as const;
const MAX_PLAN_ENTRIES = 20;

type PlanStatus = (typeof PLAN_STATUSES)[number];

export function createUpdatePlanTool(
  updatePlan: (entries: acp.PlanEntry[]) => void | Promise<void>,
): ToolDefinition {
  return {
    name: "update_plan",
    description:
      'publish and replace the live task checklist shown to the user. Call it with {"plan":[{"step":"...","status":"pending|in_progress|completed"}]}. Use it before multi-step work and whenever the active step changes, including when delegated or background-agent work starts or finishes. Keep at most one item in_progress and never mark unfinished work completed.',
    parameters: {
      type: "object",
      properties: {
        plan: {
          type: "array",
          description:
            'complete ordered checklist of {"step":"...","status":"pending|in_progress|completed"}; every update replaces the previous list',
          items: {
            type: "object",
            properties: {
              step: {
                type: "string",
                description: "short user-visible task description",
              },
              status: {
                type: "string",
                enum: [...PLAN_STATUSES],
              },
            },
            required: ["step", "status"],
            additionalProperties: false,
          },
        },
      },
      required: ["plan"],
      additionalProperties: false,
    },
    mutating: false,
    kind: "think",
    async execute(_ctx, args) {
      const parsed = parsePlan(args.plan);
      if ("error" in parsed) return parsed;
      await updatePlan(parsed.entries);
      const completed = parsed.entries.filter(
        (entry) => entry.status === "completed",
      ).length;
      const active = parsed.entries.some(
        (entry) => entry.status === "in_progress",
      );
      return {
        output: `Updated task checklist: ${completed}/${parsed.entries.length} completed${active ? ", 1 in progress" : ""}.`,
      };
    },
  };
}

function parsePlan(
  value: unknown,
): { entries: acp.PlanEntry[] } | { error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { error: "update_plan requires at least one checklist item." };
  }
  if (value.length > MAX_PLAN_ENTRIES) {
    return {
      error: `update_plan accepts at most ${MAX_PLAN_ENTRIES} checklist items.`,
    };
  }

  const entries: acp.PlanEntry[] = [];
  const seen = new Set<string>();
  let activeCount = 0;
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { error: `update_plan item ${index + 1} must be an object.` };
    }
    const { step, status } = item as { step?: unknown; status?: unknown };
    if (typeof step !== "string" || !step.trim()) {
      return {
        error: `update_plan item ${index + 1} requires a non-empty step.`,
      };
    }
    if (!PLAN_STATUSES.includes(status as PlanStatus)) {
      return {
        error: `update_plan item ${index + 1} has an invalid status.`,
      };
    }
    const content = step.trim();
    const key = content.toLocaleLowerCase();
    if (seen.has(key)) {
      return { error: `update_plan contains a duplicate step: ${content}` };
    }
    seen.add(key);
    if (status === "in_progress") activeCount++;
    entries.push({ content, status: status as PlanStatus, priority: "medium" });
  }

  if (activeCount > 1) {
    return { error: "update_plan allows at most one in_progress item." };
  }
  return { entries };
}
