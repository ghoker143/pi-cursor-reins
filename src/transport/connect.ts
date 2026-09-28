// SPDX-License-Identifier: AGPL-3.0-or-later
import { gunzipSync, gzipSync } from "node:zlib";
import { CONNECT_COMPRESS_MIN, CONNECT_MAX_FRAME_BYTES } from "../constants.ts";
import { driftError } from "../errors.ts";

export const CONNECT_FLAG_COMPRESSED = 0b0000_0001;
export const CONNECT_FLAG_END_STREAM = 0b0000_0010;
const PREFIX = 5;

export interface ConnectFrame {
  body: Uint8Array;
  compressed: boolean;
  endOfStream: boolean;
}

export function encodeConnectFrame(body: Uint8Array, flags = 0): Uint8Array {
  if (body.byteLength > CONNECT_MAX_FRAME_BYTES) {
    throw driftError(`Connect frame length ${String(body.byteLength)} exceeds the 16 MiB cap`);
  }
  const frame = new Uint8Array(PREFIX + body.length);
  const view = new DataView(frame.buffer, frame.byteOffset, PREFIX);
  view.setUint8(0, flags);
  view.setUint32(1, body.length, false);
  frame.set(body, PREFIX);
  return frame;
}

export function encodeProtobufFrame(protobuf: Uint8Array): Uint8Array {
  if (protobuf.byteLength < CONNECT_COMPRESS_MIN) return encodeConnectFrame(protobuf);
  return encodeConnectFrame(gzipSync(protobuf), CONNECT_FLAG_COMPRESSED);
}

export class ConnectFrameDecoder {
  #buffer = new Uint8Array(0);
  #read = 0;
  #write = 0;

  get #available(): number {
    return this.#write - this.#read;
  }

  #reserve(extra: number): void {
    if (this.#write + extra <= this.#buffer.length) return;
    const needed = this.#available + extra;
    if (needed <= this.#buffer.length) {
      this.#buffer.copyWithin(0, this.#read, this.#write);
    } else {
      let capacity = Math.max(this.#buffer.length * 2, 64 * 1024);
      while (capacity < needed) capacity *= 2;
      const grown = new Uint8Array(capacity);
      grown.set(this.#buffer.subarray(this.#read, this.#write));
      this.#buffer = grown;
    }
    this.#write = this.#available;
    this.#read = 0;
  }

  push(chunk: Uint8Array): ConnectFrame[] {
    if (chunk.length > 0) {
      this.#reserve(chunk.length);
      this.#buffer.set(chunk, this.#write);
      this.#write += chunk.length;
    }
    const frames: ConnectFrame[] = [];
    for (;;) {
      if (this.#available < PREFIX) break;
      const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset + this.#read, PREFIX);
      const flags = view.getUint8(0);
      const length = view.getUint32(1, false);
      if (length > CONNECT_MAX_FRAME_BYTES) {
        throw driftError(`Connect frame length ${String(length)} exceeds the 16 MiB cap`);
      }
      if (this.#available < PREFIX + length) break;
      const start = this.#read + PREFIX;
      const raw = this.#buffer.slice(start, start + length);
      this.#read = start + length;
      const compressed = (flags & CONNECT_FLAG_COMPRESSED) !== 0;
      const body = compressed
        ? new Uint8Array(gunzipSync(raw, { maxOutputLength: CONNECT_MAX_FRAME_BYTES }))
        : raw;
      frames.push({
        body,
        compressed,
        endOfStream: (flags & CONNECT_FLAG_END_STREAM) !== 0,
      });
    }
    if (this.#read === this.#write) {
      this.#read = 0;
      this.#write = 0;
    }
    return frames;
  }

  end(): void {
    if (this.#available > 0) {
      throw driftError(`Connect stream ended mid-frame with ${String(this.#available)} trailing bytes`);
    }
  }
}

export function parseTrailer(body: Uint8Array): { code?: string; message?: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(body));
  } catch (cause) {
    throw driftError("Cursor returned an invalid Connect end-of-stream trailer", cause);
  }
  if (typeof raw !== "object" || raw === null) throw driftError("Cursor returned an invalid Connect end-of-stream trailer");
  const error = (raw as { error?: unknown }).error;
  if (error === undefined) return {};
  if (typeof error !== "object" || error === null || typeof (error as { code?: unknown }).code !== "string") {
    throw driftError("Cursor returned an invalid Connect error trailer");
  }
  const code = (error as { code: string; message?: string }).code.trim();
  const message = (error as { message?: string }).message;
  if (code === "" || (message !== undefined && typeof message !== "string")) {
    throw driftError("Cursor returned an invalid Connect error trailer");
  }
  return { code, message };
}
