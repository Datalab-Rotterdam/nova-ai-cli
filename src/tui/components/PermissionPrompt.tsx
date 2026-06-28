import { Box, Text, useInput } from "ink";
import React, { useState } from "react";
import type { PermissionRequestView } from "../state/types.js";
import { useTheme } from "../theme/index.js";

const OPTIONS = [
  { id: "allow", label: "Allow" },
  { id: "allow-session", label: "Allow for this session" },
  { id: "allow-always", label: "Always allow (saved to .nova-ai/settings.json)" },
  { id: "deny", label: "Deny" },
] as const;

export function PermissionPrompt({ request }: { request: PermissionRequestView }): React.ReactElement {
  const theme = useTheme();
  const [selected, setSelected] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setSelected((i) => Math.max(0, i - 1));
    else if (key.downArrow) setSelected((i) => Math.min(OPTIONS.length - 1, i + 1));
    else if (key.return) {
      const choice = OPTIONS[selected].id;
      const scope = choice === "allow-session" ? "session" : choice === "allow-always" ? "always" : "once";
      request.resolve(choice !== "deny", scope);
    } else if (input === "a") request.resolve(true, "once");
    else if (input === "s") request.resolve(true, "session");
    else if (input === "w") request.resolve(true, "always");
    else if (input === "d") request.resolve(false, "once");
  });

  return (
    <Box flexDirection="column" borderStyle="double" borderColor={theme.warning} paddingX={1} marginY={1}>
      <Text color={theme.warning} bold>
        Permission requested: {request.toolName}
      </Text>
      <Text color={theme.muted}>{JSON.stringify(request.args)}</Text>
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((opt, i) => (
          <Text key={opt.id} color={i === selected ? theme.primary : undefined}>
            {i === selected ? "› " : "  "}
            {opt.label}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
