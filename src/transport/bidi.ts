// SPDX-License-Identifier: AGPL-3.0-or-later
import { connect, type ClientHttp2Session, type ClientHttp2Stream, type IncomingHttpHeaders } from "node:http2";
import { DEFAULT_IDLE_MS, H2_PING_MS } from "../constants.ts";
import { authError, driftError, networkError, remoteError } from "../errors.ts";
import { encodeConnectFrame, ConnectFrameDecoder, parseTrailer } from "./connect.ts";
import { debugLog } from "./debug.ts";
import { assertAllowedOrigin } from "./origin.ts";

export interface BidiHooks {
  onResponse?: (status: number, headers: Record<string, string>) => void | Promise<void>;
}

export interface ConnectBidi {
  write(protobuf: Uint8Array): Promise<void>;
  end(): void;
  destroy(): void;
  closed: Promise<void>;
}

export interface OpenConnectBidiOptions {
  origin: string;
  headers: Record<string, string>;
  token?: string;
  signal?: AbortSignal;
  idleMs?: number;
  onFrame: (body: Uint8Array) => void | Promise<void>;
  hooks?: BidiHooks;
  connectImpl?: (authority: string | URL) => ClientHttp2Session;
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function httpStatusError(status: number, path: string): Error {
  if (status === 401 || status === 403) return authError(`Cursor ${path} returned HTTP ${String(status)}`);
  return remoteError(`Cursor ${path} returned HTTP ${String(status)}`);
}

export function openConnectBidi(options: OpenConnectBidiOptions): ConnectBidi {
  const origin = assertAllowedOrigin(options.origin);
  const idleMs = options.idleMs ?? envMs("CURSOR_PROVIDER_IDLE_MS", DEFAULT_IDLE_MS);
  const path = options.headers[":path"] ?? "";
  const session = (options.connectImpl ?? connect)(origin.origin);
  const decoder = new ConnectFrameDecoder();
  let stream: ClientHttp2Stream | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let trailerSeen = false;
  let status = 0;
  let settled = false;
  let finishWrites: Promise<void> = Promise.resolve();
  let onAbort: (() => void) | undefined;

  const clearTimers = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (pingTimer) clearInterval(pingTimer);
  };

  let rejectClosed: (err: unknown) => void = () => undefined;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });

  const fail = (err: unknown): void => {
    if (settled) return;
    settled = true;
    clearTimers();
    try {
      stream?.destroy();
    } catch {
      /* ignore */
    }
    rejectClosed(err);
  };
  const succeed = (): void => {
    if (settled) return;
    settled = true;
    clearTimers();
    resolveClosed();
  };

  const resetIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => fail(networkError(`Cursor ${path} idle timeout`)), idleMs);
    idleTimer.unref();
  };

  onAbort = (): void => fail(new DOMException("Aborted", "AbortError"));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) {
    onAbort();
  }

  // When the signal was already aborted, fail() above settled the bidi: do not put
  // an authenticated request on the wire for a cancelled operation.
  if (!settled) {
    session.on("error", (err) => fail(networkError(err.message, err)));
    pingTimer = setInterval(() => {
      try {
        session.ping(() => undefined);
      } catch {
        /* session may already be closing */
      }
    }, H2_PING_MS);
    pingTimer.unref();

    stream = session.request(options.headers);
    session.unref();

  stream.on("response", (incoming: IncomingHttpHeaders) => {
    status = Number(incoming[":status"] ?? 0);
    const flat: Record<string, string> = {};
    for (const [k, v] of Object.entries(incoming)) {
      if (typeof v === "string") flat[k] = v;
      else if (Array.isArray(v)) flat[k] = v.join(",");
    }
    void Promise.resolve(options.hooks?.onResponse?.(status, flat)).catch(fail);
    if (status !== 200) {
      fail(httpStatusError(status, path));
      return;
    }
    const contentType = String(incoming["content-type"] ?? "");
    if (!contentType.startsWith("application/connect+proto")) {
      fail(driftError(`Cursor ${path} returned an invalid content type`));
    }
  });

  stream.on("data", (chunk: Uint8Array) => {
    try {
      for (const frame of decoder.push(chunk)) {
        resetIdle();
        if (trailerSeen) throw driftError("Cursor sent data after the Connect trailer");
        if (frame.endOfStream) {
          trailerSeen = true;
          const trailer = parseTrailer(frame.body);
          if (trailer.code) {
            const detail = trailer.message ? ` — ${trailer.message}` : "";
            if (trailer.code === "unauthenticated" || trailer.code === "permission_denied") {
              throw authError(`Cursor ${path} failed: ${trailer.code}${detail}`);
            }
            throw remoteError(`Cursor ${path} failed: ${trailer.code}${detail}`);
          }
          continue;
        }
        finishWrites = finishWrites.then(async () => await options.onFrame(frame.body));
        void finishWrites.catch(fail);
      }
    } catch (err) {
      fail(err);
    }
  });

  stream.on("error", (err) => fail(networkError(err.message, err)));
  stream.on("aborted", () => fail(networkError(`Cursor ${path} stream aborted`)));
  stream.on("end", () => {
    try {
      decoder.end();
    } catch (err) {
      fail(err);
      return;
    }
    void finishWrites.then(() => {
      if (settled) return;
      if (status !== 200) {
        fail(httpStatusError(status || 0, path));
        return;
      }
      if (!trailerSeen) {
        fail(driftError(`Cursor ${path} ended without a Connect trailer`));
        return;
      }
      succeed();
    }, fail);
  });

  resetIdle();
  debugLog({ event: "agent-open", path, origin: origin.origin });
  }

  const h2 = stream;
  return {
    write(protobuf: Uint8Array): Promise<void> {
      if (!h2) {
        return Promise.reject(networkError(`Cursor ${path} stream is closed (aborted before connect)`));
      }
      // AgentService does not advertise connect-content-encoding; compressed
      // frames are ignored and the run parks on heartbeat (PROTOCOL-AGENT §1).
      const frame = encodeConnectFrame(protobuf);
      return new Promise((resolve, reject) => {
        h2.write(frame, (err) => {
          if (err) reject(networkError(err.message, err));
          else resolve();
        });
      });
    },
    end(): void {
      try {
        h2?.end();
      } catch {
        /* ignore */
      }
    },
    destroy(): void {
      fail(new DOMException("Aborted", "AbortError"));
      try {
        session.destroy();
      } catch {
        /* ignore */
      }
    },
    closed: closed.finally(() => {
      if (onAbort) options.signal?.removeEventListener("abort", onAbort);
      clearTimers();
      try {
        session.destroy();
      } catch {
        /* ignore */
      }
    }),
  };
}
