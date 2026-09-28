// SPDX-License-Identifier: AGPL-3.0-or-later
import { CURSOR_AGENT_ORIGIN, CURSOR_ORIGIN } from "../constants.ts";
import { localError } from "../errors.ts";

const AGENT_HOST = /^agentn(?:\.[a-z0-9-]+)*\.api5\.cursor\.sh$/;

function parseOrigin(value: string): URL {
  try {
    return new URL(value);
  } catch (cause) {
    throw localError("Cursor backend authority is invalid", `use ${CURSOR_ORIGIN} or ${CURSOR_AGENT_ORIGIN}`, cause);
  }
}

function assertBare(url: URL, hint: string): void {
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw localError("Cursor backend authority must be a bare HTTPS origin", hint);
  }
}

export function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}

export function isAgentHost(hostname: string): boolean {
  return AGENT_HOST.test(hostname.toLowerCase());
}

/** OAuth / catalog / RunInference — api2 or loopback. */
export function assertCursorOrigin(value: string): URL {
  const url = parseOrigin(value);
  if (isLoopback(url)) return url;
  if (url.origin !== CURSOR_ORIGIN) {
    throw localError(
      `Refusing non-allowlisted origin ${url.origin}`,
      `this path only contacts ${CURSOR_ORIGIN}`,
    );
  }
  assertBare(url, `use ${CURSOR_ORIGIN}`);
  return new URL(url.origin);
}

/** AgentService or shared bidi — api2, agentn*.api5.cursor.sh, or loopback. */
export function assertAllowedOrigin(value: string): URL {
  const url = parseOrigin(value);
  if (isLoopback(url)) return url;
  const host = url.hostname.toLowerCase();
  const allowed = url.origin === CURSOR_ORIGIN || isAgentHost(host);
  if (!allowed || url.protocol !== "https:") {
    throw localError(
      `Refusing non-allowlisted origin ${url.origin}`,
      `use ${CURSOR_ORIGIN} or ${CURSOR_AGENT_ORIGIN}`,
    );
  }
  assertBare(url, `use ${CURSOR_ORIGIN} or ${CURSOR_AGENT_ORIGIN}`);
  return new URL(url.origin);
}

export const ALLOWED_ORIGINS = [CURSOR_ORIGIN, CURSOR_AGENT_ORIGIN] as const;
