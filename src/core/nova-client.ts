import { NovaAI } from "@datalabrotterdam/nova-sdk";

/**
 * The one place Nova API clients are created. `NOVA_BASE_URL` points every
 * mode (TUI, headless, ACP) at another Nova gateway: self-hosted
 * installations and the end-to-end tests' fake server.
 */
export function createNovaClient(apiKey: string): NovaAI {
  const baseUrl = process.env.NOVA_BASE_URL?.trim();
  return new NovaAI({ apiKey, ...(baseUrl ? { baseUrl } : {}) });
}
