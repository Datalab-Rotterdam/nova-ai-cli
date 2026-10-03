process.env.NOVA_PTY_STANDALONE = "1";

export {};
setTimeout(() => {
  process.stderr.write("PTY runtime watchdog timed out.\n");
  process.exit(98);
}, 15_000).unref();
await import("./pty-runtime-e2e.test.js");
