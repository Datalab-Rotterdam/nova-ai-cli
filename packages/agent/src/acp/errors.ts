import * as acp from "@agentclientprotocol/sdk";
import { NovaAIError } from "@datalabrotterdam/nova-sdk";

/** -32002 (resource not found) with a message that names the session. */
export function sessionNotFound(sessionId: string): acp.RequestError {
  return new acp.RequestError(-32002, `Session ${sessionId} not found`, {
    sessionId,
  });
}

/**
 * Nova API failures as ACP errors: a rejected key becomes auth_required, so
 * clients can offer to authenticate; everything else keeps status and
 * request id, which support needs to trace the failure.
 */
export function toAcpError(error: unknown): unknown {
  if (!(error instanceof NovaAIError)) return error;
  const detail = `Nova AI request failed (status ${error.status}${error.requestId ? `, requestId ${error.requestId}` : ""}): ${error.message}`;
  if (error.status === 401 || error.status === 403) {
    return acp.RequestError.authRequired(
      { status: error.status, requestId: error.requestId },
      detail,
    );
  }
  return new Error(detail);
}
