import { render, Box, Text } from "ink";
import React from "react";
import { DiffView } from "./src/tui/components/DiffView.js";

const before = `function greet(name) {
  console.log("Hello " + name);
}
`;

const after = `function greet(name) {
  console.log(\`Hello, \${name}!\`);
  return true;
}
`;

render(
  <Box flexDirection="column">
    <Text bold color="#6f27f5">
      write_file: example.js
    </Text>
    <DiffView before={before} after={after} />
  </Box>,
);
