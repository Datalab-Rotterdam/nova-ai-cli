import { Box } from "ink";
import React from "react";
import type { UIMessage } from "../state/types.js";
import { Message } from "./Message.js";

export function MessageList({
  messages,
  maxLiveHeight,
}: {
  messages: UIMessage[];
  maxLiveHeight: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" height={maxLiveHeight} overflowY="hidden">
      <Box flexGrow={1} />
      {messages.map((message) => (
        <Message key={message.id} message={message} />
      ))}
    </Box>
  );
}
