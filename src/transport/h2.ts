// SPDX-License-Identifier: AGPL-3.0-or-later
import { connect, type ClientHttp2Session, type ClientHttp2Stream, type IncomingHttpHeaders } from "node:http2";
import {
  CURSOR_ORIGIN,
  DEFAULT_FIRST_TOKEN_MS,
  DEFAULT_IDLE_MS,
  DEFAULT_RUN_READY_MS,
} from "../constants.ts";
import { authError, CursorError, driftError, networkError, remoteError } from "../errors.ts";
import {
  encodeClientMessage,
  decodeServerMessage,
  assertKnownServerFrame,
  type ClientMessage,
  type ServerMessage,
} from "../proto/inference.ts";
import type { MachineIdentity } from "../identity/index.ts";
import { encodeProtobufFrame, ConnectFrameDecoder, parseTrailer } from "./connect.ts";
import { debugLog } from "./debug.ts";
import { inferenceRequestHeaders } from "./headers.ts";
import { assertCursorOrigin } from "./origin.ts";

export interface StreamHooks {
  onResponse?: (status: number, headers: Record<string, string>) => void | Promise<void>;
}

export interface RunInferenceOptions {
  token: string;
  identity: MachineIdentity;
  origin?: string;
  signal?: AbortSignal;
  runRequest: ClientMessage;
  invoke: ClientMessage;
  onMessage: (message: ServerMessage) => void | Promise<void>;
  hooks?: StreamHooks;
  connectImpl?: (authority: string | URL) => ClientHttp2Session;
  now?: () => number;
  clientKey?: string;
  requestId?: string;
  runReadyMs?: number;
  idleMs?: number;
  firstTokenMs?: number;
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function writeFrame(stream: ClientHttp2Stream, message: ClientMessage): Promise<void> {
  const frame = encodeProtobufFrame(encodeClientMessage(message));
  return new Promise((resolve, reject) => {
    stream.write(frame, (err) => {
      if (err) reject(networkError(err.message, err));
      else resolve();
    });
  });
}

function httpStatusError(status: number): Error {
  if (status === 401 || status === 403) return authError(`Cursor RunInference returned HTTP ${String(status)}`);
  return remoteError(`Cursor RunInference returned HTTP ${String(status)}`);
}

export async function runInferenceStream(options: RunInferenceOptions): Promise<void> {
  const origin = assertCursorOrigin(options.origin ?? CURSOR_ORIGIN);
  const runReadyMs = options.runReadyMs ?? envMs("CURSOR_PROVIDER_RUN_READY_MS", DEFAULT_RUN_READY_MS);
  const idleMs = options.idleMs ?? envMs("CURSOR_PROVIDER_IDLE_MS", DEFAULT_IDLE_MS);
  const firstTokenMs = options.firstTokenMs ?? envMs("CURSOR_PROVIDER_FIRST_TOKEN_MS", DEFAULT_FIRST_TOKEN_MS);
  const requestId = options.requestId ?? crypto.randomUUID();
  const clientKey = options.clientKey ?? Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
  const headers = inferenceRequestHeaders({
    token: options.token,
    identity: options.identity,
    requestId,
    clientKey,
    nowMs: (options.now ?? Date.now)(),
  });

  debugLog({
    event: "request",
    path: headers[":path"],
    requestId,
    conversation:
      options.runRequest.case === "runRequest" ? options.runRequest.value.conversationId : undefined,
  });

  const session = (options.connectImpl ?? connect)(origin.origin);
  // Never let a lingering session pin the event loop (same discipline as bidi.ts);
  // the finally below destroys it outright rather than waiting on a GOAWAY dance.
  session.unref();
  const decoder = new ConnectFrameDecoder();
  let stream: ClientHttp2Stream | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let firstTimer: ReturnType<typeof setTimeout> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  let sawReady = false;
  let sawContent = false;
  let sawInvocationEnd = false;
  let trailerSeen = false;
  let status = 0;
  let settled = false;
  let finishWrites: Promise<void> = Promise.resolve();
  let onAbort: (() => void) | undefined;

  const clearTimers = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (firstTimer) clearTimeout(firstTimer);
    if (readyTimer) clearTimeout(readyTimer);
  };

  await new Promise<void>((resolve, reject) => {
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      try {
        stream?.destroy();
      } catch {
        /* ignore */
      }
      reject(err);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve();
    };

    const resetIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail(networkError("Cursor RunInference idle timeout")), idleMs);
    };

    onAbort = (): void => fail(new DOMException("Aborted", "AbortError"));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
      return;
    }

    session.on("error", (err) => fail(networkError(err.message, err)));
    stream = session.request(headers);

    stream.on("response", (incoming: IncomingHttpHeaders) => {
      status = Number(incoming[":status"] ?? 0);
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(incoming)) {
        if (typeof v === "string") flat[k] = v;
        else if (Array.isArray(v)) flat[k] = v.join(",");
      }
      void Promise.resolve(options.hooks?.onResponse?.(status, flat)).catch(fail);
      if (status !== 200) {
        fail(httpStatusError(status));
        return;
      }
      const contentType = String(incoming["content-type"] ?? "");
      if (!contentType.startsWith("application/connect+proto")) {
        fail(driftError("Cursor RunInference returned an invalid content type"));
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
              if (trailer.code === "permission_denied") {
                throw new CursorError(
                  "remote",
                  "Cursor InferenceService/RunInference is not enabled for this account",
                  "this is a Cursor plan entitlement (headers/identity already work); use CURSOR_PROVIDER_CHANNEL=agent (default) for AgentService",
                );
              }
              throw remoteError(`Cursor RunInference failed: ${trailer.code}${detail}`);
            }
            continue;
          }
          const message = decodeServerMessage(frame.body);
          assertKnownServerFrame(message);
          if (message.case === "runReady") {
            if (message.value.modelId === "") throw driftError("Cursor runReady has no resolved model");
            sawReady = true;
            if (readyTimer) clearTimeout(readyTimer);
          }
          if (message.case === "invocationResponse" && !sawContent) {
            sawContent = true;
            if (firstTimer) clearTimeout(firstTimer);
          }
          if (message.case === "invocationEnd") {
            sawInvocationEnd = true;
            if (firstTimer) clearTimeout(firstTimer);
          }
          finishWrites = finishWrites.then(async () => await options.onMessage(message));
          void finishWrites.catch(fail);
        }
      } catch (err) {
        fail(err);
      }
    });

    stream.on("error", (err) => fail(networkError(err.message, err)));
    stream.on("aborted", () => fail(networkError("Cursor RunInference stream aborted")));
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
          fail(httpStatusError(status || 0));
          return;
        }
        if (!trailerSeen) {
          fail(driftError("Cursor RunInference ended without a Connect trailer"));
          return;
        }
        succeed();
      }, fail);
    });

    readyTimer = setTimeout(() => fail(networkError("Cursor runReady timed out")), runReadyMs);

    const h2 = stream;
    void (async () => {
      try {
        await writeFrame(h2, options.runRequest);
        while (!sawReady && !settled) await new Promise((r) => setTimeout(r, 10));
        if (settled) return;
        await writeFrame(h2, options.invoke);
        firstTimer = setTimeout(() => fail(networkError("Cursor first-token timed out")), firstTokenMs);
        resetIdle();
        while (!sawInvocationEnd && !settled) await new Promise((r) => setTimeout(r, 10));
        if (settled) return;
        await writeFrame(h2, { case: "finishRun" });
        h2.end();
      } catch (err) {
        fail(err);
      }
    })();
  }).finally(() => {
    if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    clearTimers();
    try {
      stream?.destroy();
    } catch {
      /* ignore */
    }
    try {
      session.destroy();
    } catch {
      /* ignore */
    }
  });

  debugLog({ event: "done", requestId });
}
