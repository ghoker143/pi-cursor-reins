// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import { MAX_BLOB_BYTES, MAX_BLOB_STORE_BYTES } from "../constants.ts";
import { localError } from "../errors.ts";

function hex(id: Uint8Array): string {
  return Buffer.from(id).toString("hex");
}

export class BlobStore {
  readonly #map = new Map<string, Uint8Array>();
  #bytes = 0;

  get size(): number {
    return this.#map.size;
  }

  put(data: Uint8Array): Uint8Array {
    if (data.byteLength > MAX_BLOB_BYTES) {
      throw localError(
        `Cursor blob exceeds the ${String(MAX_BLOB_BYTES)} byte per-blob limit`,
        "reduce tool-result or prompt size",
      );
    }
    const id = new Uint8Array(createHash("sha256").update(data).digest());
    const key = hex(id);
    const existing = this.#map.get(key);
    if (existing) return id;
    if (this.#bytes + data.byteLength > MAX_BLOB_STORE_BYTES) {
      throw localError(
        `Cursor blob store would exceed the ${String(MAX_BLOB_STORE_BYTES)} byte cap`,
        "start a new Pi session; this provider does not evict blobs Cursor still references",
      );
    }
    this.#map.set(key, data);
    this.#bytes += data.byteLength;
    return id;
  }

  get(id: Uint8Array): Uint8Array | undefined {
    return this.#map.get(hex(id));
  }

  has(id: Uint8Array): boolean {
    return this.#map.has(hex(id));
  }

  get byteLength(): number {
    return this.#bytes;
  }

  /** Import a previously persisted blob. Id must match SHA-256 of data. */
  load(idHex: string, data: Uint8Array): void {
    if (this.#map.has(idHex)) return;
    const expected = hex(new Uint8Array(createHash("sha256").update(data).digest()));
    if (expected !== idHex) {
      throw localError("persisted Cursor blob id does not match its bytes", "drop the remote handle and rebuild");
    }
    if (this.#bytes + data.byteLength > MAX_BLOB_STORE_BYTES) {
      throw localError(
        `Cursor blob store would exceed the ${String(MAX_BLOB_STORE_BYTES)} byte cap`,
        "start a new Pi session; this provider does not evict blobs Cursor still references",
      );
    }
    this.#map.set(idHex, data);
    this.#bytes += data.byteLength;
  }

  snapshot(): { idHex: string; data: Uint8Array }[] {
    return [...this.#map.entries()].map(([idHex, data]) => ({ idHex, data }));
  }
}
