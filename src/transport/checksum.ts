// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MachineIdentity } from "../identity/index.ts";

/** PROTOCOL §6 — Cursor IDE 3.18.9 six-byte minute checksum, JS shift semantics. */
export function cursorChecksum(identity: MachineIdentity, nowMs: number = Date.now()): string {
  const minute = Math.floor(nowMs / 1_000_000);
  const bytes = new Uint8Array([
    (minute >> 40) & 255,
    (minute >> 32) & 255,
    (minute >> 24) & 255,
    (minute >> 16) & 255,
    (minute >> 8) & 255,
    minute & 255,
  ]);
  let previous = 165;
  for (let i = 0; i < bytes.length; i += 1) {
    const current = bytes[i];
    if (current === undefined) throw new Error("checksum input incomplete");
    bytes[i] = ((current ^ previous) + (i % 256)) & 255;
    previous = bytes[i] ?? previous;
  }
  const prefix = Buffer.from(bytes).toString("base64");
  return identity.macMachineId === undefined
    ? `${prefix}${identity.machineId}`
    : `${prefix}${identity.machineId}/${identity.macMachineId}`;
}
