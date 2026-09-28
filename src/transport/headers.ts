// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  CURSOR_CLI_VERSION,
  CURSOR_IDE_COMMIT,
  CURSOR_IDE_VERSION,
  AGENT_RUN_PATH,
  RUN_INFERENCE_PATH,
} from "../constants.ts";
import type { MachineIdentity } from "../identity/index.ts";
import { localError } from "../errors.ts";
import { cursorChecksum } from "./checksum.ts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface InferenceHeaderOptions {
  token: string;
  identity: MachineIdentity;
  requestId: string;
  clientKey: string;
  nowMs?: number;
  timezone?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  ghostMode?: boolean;
}

function assertHeader(name: string, value: string): void {
  if (value.includes("\r") || value.includes("\n")) {
    throw localError(`${name} contains a line break`, "rotate the credential with /login cursor");
  }
}

export function inferenceRequestHeaders(options: InferenceHeaderOptions): Record<string, string> {
  assertHeader("Cursor credential", options.token);
  assertHeader("Cursor request id", options.requestId);
  assertHeader("Cursor client key", options.clientKey);
  const timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  assertHeader("Cursor timezone", timezone);
  if (!/^[0-9a-f]{64}$/.test(options.clientKey)) {
    throw localError("Cursor client key must be 32-byte lowercase hex", "file a bug in pi-cursor-provider");
  }
  if (!uuidPattern.test(options.requestId)) {
    throw localError("Cursor request id must be a UUID", "file a bug in pi-cursor-provider");
  }
  return {
    ":method": "POST",
    ":path": RUN_INFERENCE_PATH,
    authorization: `Bearer ${options.token}`,
    cookie: `CursorCookie=Cookie-${options.token.slice(0, 15)}`,
    "connect-accept-encoding": "gzip",
    "connect-content-encoding": "gzip",
    "connect-protocol-version": "1",
    "content-type": "application/connect+proto",
    "user-agent": "connect-es/1.6.1",
    "x-amzn-trace-id": `Root=${options.requestId}`,
    "x-client-key": options.clientKey,
    "x-cursor-checksum": cursorChecksum(options.identity, options.nowMs),
    "x-cursor-client-arch": options.arch ?? process.arch,
    "x-cursor-client-commit": CURSOR_IDE_COMMIT,
    "x-cursor-client-device-type": "desktop",
    "x-cursor-client-os": options.platform ?? process.platform,
    "x-cursor-client-type": "ide",
    "x-cursor-client-version": CURSOR_IDE_VERSION,
    "x-cursor-streaming": "true",
    "x-cursor-timezone": timezone,
    "x-ghost-mode": String(options.ghostMode ?? false),
    "x-new-onboarding-completed": "false",
    "x-request-id": options.requestId,
  };
}

export interface AgentHeaderOptions {
  token: string;
  requestId: string;
}

/** PROTOCOL-AGENT §1 — CLI identity, no checksum (CLI AgentService path). */
export function agentRequestHeaders(options: AgentHeaderOptions): Record<string, string> {
  assertHeader("Cursor credential", options.token);
  assertHeader("Cursor request id", options.requestId);
  if (!uuidPattern.test(options.requestId)) {
    throw localError("Cursor request id must be a UUID", "file a bug in pi-cursor-provider");
  }
  return {
    ":method": "POST",
    ":path": AGENT_RUN_PATH,
    authorization: `Bearer ${options.token}`,
    "connect-protocol-version": "1",
    "content-type": "application/connect+proto",
    te: "trailers",
    "user-agent": "connect-es/1.6.1",
    "x-cursor-client-type": "cli",
    "x-cursor-client-version": CURSOR_CLI_VERSION,
    "x-ghost-mode": "true",
    "x-request-id": options.requestId,
  };
}
