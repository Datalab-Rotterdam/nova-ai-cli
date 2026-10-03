/**
 * Nova's ACP extension methods and notifications. The ACP spec reserves
 * names starting with "_" for extensions, so standard clients never collide
 * with them; they are advertised in initialize under
 * agentCapabilities._meta["nova-ai-cli"].
 */
export const NOVA_METHODS = {
  backgroundStartTerminal: "_nova/background/start_terminal",
  backgroundStartPrompt: "_nova/background/start_prompt",
  backgroundList: "_nova/background/list",
  backgroundOutput: "_nova/background/output",
  backgroundKill: "_nova/background/kill",
  backgroundRelease: "_nova/background/release",
  queueEnqueue: "_nova/queue/enqueue",
  queueList: "_nova/queue/list",
  queueEditBegin: "_nova/queue/edit_begin",
  queueUpdate: "_nova/queue/update",
  queueRemove: "_nova/queue/remove",
  queueClear: "_nova/queue/clear",
  queueTakeNext: "_nova/queue/take_next",
  sessionCheckpoints: "_nova/session/checkpoints",
  sessionRewind: "_nova/session/rewind",
  sessionCompact: "_nova/session/compact",
  sessionContextUsage: "_nova/session/context_usage",
} as const;

export const NOVA_NOTIFICATIONS = {
  backgroundUpdate: "_nova/background/update",
  queueChanged: "_nova/queue/changed",
  sessionRewound: "_nova/session/rewound",
} as const;

/** Bump when an extension changes incompatibly. */
export const NOVA_EXTENSIONS_VERSION = 1;

export function novaExtensionsMeta(): Record<string, unknown> {
  return {
    version: NOVA_EXTENSIONS_VERSION,
    methods: Object.values(NOVA_METHODS),
    notifications: Object.values(NOVA_NOTIFICATIONS),
  };
}
