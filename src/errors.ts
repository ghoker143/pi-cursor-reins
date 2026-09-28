// SPDX-License-Identifier: AGPL-3.0-or-later
export type CursorErrorKind = "auth" | "network" | "protocol-drift" | "remote" | "local";

export class CursorError extends Error {
  readonly kind: CursorErrorKind;
  readonly nextStep: string;

  constructor(kind: CursorErrorKind, message: string, nextStep: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CursorError";
    this.kind = kind;
    this.nextStep = nextStep;
  }

  userMessage(): string {
    return `${this.message} (${this.kind}) Next: ${this.nextStep}`;
  }
}

export function authError(message: string, cause?: unknown): CursorError {
  return new CursorError(kindAuth, message, "run /login cursor", { cause });
}

export function networkError(message: string, cause?: unknown): CursorError {
  return new CursorError("network", message, "check connectivity to api2.cursor.sh or agentn.us.api5.cursor.sh", {
    cause,
  });
}

export function driftError(message: string, cause?: unknown): CursorError {
  return new CursorError("protocol-drift", message, "update pi-cursor-provider; this Cursor frame is not in PROTOCOL.md", {
    cause,
  });
}

export function remoteError(message: string, cause?: unknown): CursorError {
  return new CursorError("remote", message, "retry; if it persists, check Cursor status or /login cursor", {
    cause,
  });
}

export function localError(message: string, nextStep: string, cause?: unknown): CursorError {
  return new CursorError("local", message, nextStep, { cause });
}

const kindAuth: CursorErrorKind = "auth";

/** SPEC FR-2.b — unknown outer RunInference field / forged exec frame. */
export const EXEC_DRIFT_MESSAGE = "Protocol violation: this endpoint must not receive execution requests";

/** L4b — native Cursor exec answered with a typed reject; no local operation. */
export const NATIVE_EXEC_REJECT =
  "Do not retry this native Cursor tool. It is unavailable. No operation was performed.";

export const LOCAL_TOOL_LOOP_MESSAGE =
  "Cursor repeatedly requested disabled local tools without a Pi MCP result. Stopped to avoid a retry loop.";

/** Resume hit a stale remote handle; caller should mint a new conversation and replay Pi history. */
export const STALE_REMOTE_NEXT =
  "abandon the Cursor conversation handle and rebuild this turn from the Pi transcript";

export function staleRemoteError(message: string, cause?: unknown): CursorError {
  return new CursorError("local", message, STALE_REMOTE_NEXT, { cause });
}

export function isStaleRemote(error: unknown): boolean {
  return error instanceof CursorError && error.nextStep === STALE_REMOTE_NEXT;
}
