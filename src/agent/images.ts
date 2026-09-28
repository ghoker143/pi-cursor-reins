// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_BLOB_BYTES } from "../constants.ts";
import { localError } from "../errors.ts";
import type { WireImage } from "../proto/agent.ts";
import type { InferenceIR, IrImage } from "../session/ir.ts";

const ALLOWED_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);

export type { WireImage };

export function extensionForMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/gif") return "gif";
  if (mimeType === "image/webp") return "webp";
  if (mimeType === "image/bmp") return "bmp";
  return "bin";
}

export function decodeIrImage(image: IrImage, where: string): { mimeType: string; data: Uint8Array } {
  const mimeType = image.mimeType.trim().toLowerCase();
  if (!ALLOWED_MIME.has(mimeType)) {
    throw localError(
      `Unsupported image mime type '${image.mimeType}' (${where})`,
      "send png, jpeg, gif, webp, or bmp",
    );
  }
  if (typeof image.data !== "string" || image.data.trim() === "") {
    throw localError(`Image part is missing base64 data (${where})`, "attach a real image, not an empty part");
  }
  const data = new Uint8Array(Buffer.from(image.data.replace(/\s+/g, ""), "base64"));
  if (data.byteLength === 0) {
    throw localError(`Image part is not valid base64 (${where})`, "reattach the image");
  }
  if (data.byteLength > MAX_BLOB_BYTES) {
    throw localError(
      `Image exceeds the ${String(MAX_BLOB_BYTES)} byte limit (${where})`,
      "use a smaller image; Pi already resizes when it can",
    );
  }
  return { mimeType, data };
}

export function toWireImages(images: IrImage[] | undefined, where: string): WireImage[] {
  return (images ?? []).map((image) => {
    const decoded = decodeIrImage(image, where);
    const uuid = crypto.randomUUID();
    return {
      uuid,
      path: `pi-image-${uuid}.${extensionForMime(decoded.mimeType)}`,
      mimeType: decoded.mimeType,
      data: decoded.data,
    };
  });
}

export function irHasImages(ir: InferenceIR): boolean {
  return ir.messages.some(
    (m) => (m.images?.length ?? 0) > 0 || (m.toolResult?.images?.length ?? 0) > 0,
  );
}
