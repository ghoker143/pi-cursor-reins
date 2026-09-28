// SPDX-License-Identifier: AGPL-3.0-or-later
import { appendFileSync } from "node:fs";
import { DEBUG_ENV, DEBUG_LOG_FILE } from "../constants.ts";

export function debugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[DEBUG_ENV];
  return v === "1" || v === "true";
}

export function redact(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, "Bearer ***")
    .replace(/CursorCookie=Cookie-[^;\s]+/g, "CursorCookie=Cookie-***")
    // Covers every credential field shape this codebase touches: OAuth poll returns
    // camelCase (accessToken/refreshToken), refresh takes snake_case, plus a bare
    // "token" catch-all. Keep in sync with src/auth/index.ts.
    .replace(/("(?:access|refresh|access_token|refresh_token|accessToken|refreshToken|id_token|idToken|token)"\s*:\s*")[^"]+/g, "$1***")
    // Bare JWT fallback (e.g. a token accidentally logged outside a known key).
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "***");
}

export function debugLog(record: Record<string, unknown>): void {
  if (!debugEnabled()) return;
  const line = redact(`${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
  appendFileSync(DEBUG_LOG_FILE, line);
}
