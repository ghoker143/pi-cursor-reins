// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  CURSOR_ORIGIN,
  EXPIRY_SKEW_MS,
  LOGIN_URL,
  POLL_INTERVAL_MS,
  POLL_PATH,
  POLL_WINDOW_MS,
  REFRESH_CLIENT_ID,
  REFRESH_DEADLINE_MS,
  REFRESH_PATH,
} from "../constants.ts";
import { authError, localError } from "../errors.ts";

export interface OAuthTokens {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
  [key: string]: unknown;
}

export interface AuthRequest {
  verifier: string;
  challenge: string;
  uuid: string;
  url: string;
}

export interface AuthDependencies {
  fetch: typeof fetch;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  randomBytes: (n: number) => Uint8Array;
  randomUuid: () => string;
}

const defaults: AuthDependencies = {
  fetch,
  sleep: (ms, signal) => delay(ms, undefined, { signal }),
  randomBytes,
  randomUuid: randomUUID,
};

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function cursorTokenExpiry(token: string): number {
  const payload = token.split(".")[1];
  if (!payload) throw authError("Cursor access token is not a JWT");
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch (cause) {
    throw authError("Cursor access token has an invalid JWT payload", cause);
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    typeof (decoded as { exp?: unknown }).exp !== "number"
  ) {
    throw authError("Cursor access token has no valid expiry");
  }
  return (decoded as { exp: number }).exp * 1000 - EXPIRY_SKEW_MS;
}

export function createAuthRequest(deps: Pick<AuthDependencies, "randomBytes" | "randomUuid"> = defaults): AuthRequest {
  const raw = deps.randomBytes(32);
  if (raw.byteLength !== 32) throw localError("Cursor login verifier must be 32 bytes", "retry /login cursor");
  const verifier = b64url(raw);
  // PROTOCOL §7: hash the base64url verifier STRING, never the raw bytes.
  const challenge = b64url(createHash("sha256").update(verifier, "utf8").digest());
  const uuid = deps.randomUuid();
  const params = new URLSearchParams({
    challenge,
    uuid,
    mode: "login",
    supportsSelectedTeamLogin: "true",
    redirectTarget: "cli",
  });
  return { verifier, challenge, uuid, url: `${LOGIN_URL}?${params.toString()}` };
}

function pollHeaders(): Record<string, string> {
  const traceId = randomBytes(16).toString("hex");
  const spanId = randomBytes(8).toString("hex");
  return {
    traceparent: `00-${traceId}-${spanId}-00`,
    "x-ghost-mode": "implicit-false",
    "x-new-onboarding-completed": "false",
    "x-cursor-client-type": "ide",
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export async function pollAuth(
  request: Pick<AuthRequest, "uuid" | "verifier">,
  signal: AbortSignal,
  deps: Pick<AuthDependencies, "fetch" | "sleep"> = defaults,
): Promise<OAuthTokens> {
  const deadline = Date.now() + POLL_WINDOW_MS;
  let lastError: unknown;
  while (!signal.aborted && Date.now() < deadline) {
    await deps.sleep(POLL_INTERVAL_MS, signal);
    if (signal.aborted) break;
    try {
      const url = new URL(POLL_PATH, CURSOR_ORIGIN);
      url.search = new URLSearchParams({ uuid: request.uuid, verifier: request.verifier }).toString();
      const response = await deps.fetch(url, { headers: pollHeaders(), signal });
      if (response.status === 404) continue;
      if (response.status === 403) {
        const body: unknown = await response.json().catch(() => undefined);
        const err = asRecord(body)?.error;
        if (typeof err === "string") throw authError(`Cursor login denied by sign-in policy: ${err}`);
      }
      if (!response.ok) throw authError(`Cursor login poll returned HTTP ${String(response.status)}`);
      const body = asRecord(await response.json());
      const access = body?.accessToken;
      const refresh = body?.refreshToken;
      if (typeof access !== "string" || access === "" || typeof refresh !== "string" || refresh === "") {
        throw authError("Cursor authentication response is missing tokens");
      }
      return { type: "oauth", access, refresh, expires: cursorTokenExpiry(access) };
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.message.includes("sign-in policy"))) throw error;
      // A well-formed response without tokens is a deterministic shape drift —
      // polling again cannot fix it.
      if (error instanceof Error && error.message.includes("missing tokens")) throw error;
      // Transient errors (5xx, network) keep polling, but are reported when the
      // window expires instead of vanishing behind a bare "timed out".
      lastError = error;
    }
  }
  throw authError("Cursor login polling timed out", lastError);
}

export async function refreshToken(
  credentials: Pick<OAuthTokens, "access" | "refresh">,
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<OAuthTokens> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), REFRESH_DEADLINE_MS);
  const onAbort = (): void => deadline.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const response = await request(new URL(REFRESH_PATH, CURSOR_ORIGIN), {
      method: "POST",
      headers: { "content-type": "application/json", "x-cursor-client-type": "ide" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        client_id: REFRESH_CLIENT_ID,
        refresh_token: credentials.refresh,
      }),
      signal: deadline.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw authError(`Cursor token refresh returned HTTP ${String(response.status)}`);
    }
    if (!response.ok) throw authError(`Cursor token refresh returned HTTP ${String(response.status)}`);
    const body = asRecord(await response.json());
    if (body?.shouldLogout === true) {
      throw authError("Cursor revoked this session; sign in again with /login cursor");
    }
    const access = body?.access_token;
    if (typeof access !== "string" || access === "") throw authError("Cursor refresh response is missing an access token");
    return {
      type: "oauth",
      access,
      refresh: credentials.refresh,
      expires: cursorTokenExpiry(access),
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

export function getApiKey(credentials: Pick<OAuthTokens, "access">): string {
  return credentials.access;
}
