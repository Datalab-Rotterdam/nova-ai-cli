import type { ToolDefinition } from "./types.js";

export function createEnterPlanModeTool(
  enterPlanMode: () => void | Promise<void>,
): ToolDefinition {
  return {
    name: "enter_plan_mode",
    description:
      "enter_plan_mode: {} - switch this session from agent mode to plan mode when further workspace actions are no longer needed. This is a one-way, least-privilege transition: it cannot change permission settings or enable agent/bypass modes.",
    mutating: false,
    kind: "switch_mode",
    async execute(_ctx, args) {
      if (Object.keys(args).length > 0) {
        return {
          error:
            "enter_plan_mode does not accept arguments and cannot change permission settings.",
        };
      }
      await enterPlanMode();
      return {
        output:
          "Switched to plan mode. Produce the plan now; no further tools are available in this turn.",
        disableFurtherTools: true,
      };
    },
  };
}
