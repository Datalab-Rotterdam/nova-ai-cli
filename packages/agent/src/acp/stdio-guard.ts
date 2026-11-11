/**
 * In ACP mode stdout carries the JSON-RPC stream, so a single stray
 * console.log (ours or a dependency's) corrupts the connection. Route every
 * console method that writes to stdout to stderr instead. Returns a restore
 * function for tests.
 */
export function redirectConsoleToStderr(): () => void {
  const methods = ["log", "info", "debug", "dir", "table", "trace"] as const;
  const original = Object.fromEntries(
    methods.map((method) => [method, console[method]]),
  ) as Record<(typeof methods)[number], (...args: unknown[]) => void>;
  const toStderr = (...args: unknown[]) => console.error(...args);
  for (const method of methods) {
    (console as unknown as Record<string, unknown>)[method] = toStderr;
  }
  return () => {
    for (const method of methods) {
      (console as unknown as Record<string, unknown>)[method] = original[method];
    }
  };
}
