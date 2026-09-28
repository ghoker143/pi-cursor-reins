// SPDX-License-Identifier: AGPL-3.0-or-later
import { request as httpsRequest, type RequestOptions } from "node:https";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { AI_SERVICE, CURSOR_CLI_VERSION, CURSOR_ORIGIN } from "../constants.ts";
import { authError, networkError, remoteError } from "../errors.ts";
import { assertCursorOrigin } from "./origin.ts";

export type UnaryRequest = (
  options: RequestOptions,
  callback: (response: import("node:http").IncomingMessage) => void,
) => import("node:http").ClientRequest;

export interface UnaryOptions {
  token: string;
  method: string;
  body: Uint8Array;
  signal?: AbortSignal;
  request?: UnaryRequest;
  timeoutMs?: number;
}

function decodeBody(body: Uint8Array, encoding: string | undefined): Uint8Array {
  if (encoding === "gzip") return new Uint8Array(gunzipSync(body));
  if (encoding === "br") return new Uint8Array(brotliDecompressSync(body));
  return body;
}

export function unary(options: UnaryOptions): Promise<Uint8Array> {
  const origin = assertCursorOrigin(CURSOR_ORIGIN);
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const send = options.request ?? httpsRequest;
    const req = send(
      {
        protocol: "https:",
        host: origin.hostname,
        port: origin.port === "" ? 443 : Number(origin.port),
        path: `/${AI_SERVICE}/${options.method}`,
        method: "POST",
        headers: {
          "accept-encoding": "gzip,br",
          authorization: `Bearer ${options.token}`,
          "connect-protocol-version": "1",
          "content-type": "application/proto",
          "user-agent": "connect-es/1.6.1",
          "x-cursor-client-type": "cli",
          "x-cursor-client-version": CURSOR_CLI_VERSION,
          "x-ghost-mode": "false",
          "x-request-id": crypto.randomUUID(),
          "content-length": String(options.body.byteLength),
        },
      },
      (incoming) => {
        const chunks: Uint8Array[] = [];
        let size = 0;
        incoming.on("data", (chunk: Uint8Array) => {
          size += chunk.length;
          if (size > 4 * 1024 * 1024) {
            req.destroy(remoteError("Cursor catalog response exceeded its size limit"));
          } else chunks.push(chunk);
        });
        incoming.on("end", () => {
          const status = incoming.statusCode ?? 0;
          if (status === 401 || status === 403) {
            reject(authError(`Cursor ${options.method} returned HTTP ${String(status)}`));
            return;
          }
          if (status !== 200) {
            reject(remoteError(`Cursor ${options.method} returned HTTP ${String(status)}`));
            return;
          }
          try {
            resolve(decodeBody(Buffer.concat(chunks), incoming.headers["content-encoding"]));
          } catch (cause) {
            reject(remoteError(`Cursor ${options.method} returned invalid protobuf`, cause));
          }
        });
        incoming.on("error", (err) => reject(networkError(err.message, err)));
      },
    );
    req.on("error", (err) => reject(networkError(err.message, err)));
    req.setTimeout(options.timeoutMs ?? 10_000, () => {
      req.destroy(networkError(`Cursor ${options.method} timed out`));
    });
    const signal = options.signal;
    if (signal) {
      const abort = (): void => {
        req.destroy(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", abort, { once: true });
      req.on("close", () => {
        signal.removeEventListener("abort", abort);
      });
    }
    req.write(options.body);
    req.end();
  });
}
