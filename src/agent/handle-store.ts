// SPDX-License-Identifier: AGPL-3.0-or-later
/** Disk handle: Cursor conversation_id + checkpoint + blobs, keyed by Pi sessionId. */

import { createHash, type Hash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  HANDLE_DIR_ENV,
  MAX_BLOB_STORE_BYTES,
  MAX_CHECKPOINT_BYTES,
} from "../constants.ts";
import { isStaleRemote, staleRemoteError } from "../errors.ts";
import type { IrEvent, IrMessage } from "../session/ir.ts";
import { BlobStore } from "./blob-store.ts";

export type RebuildReason =
  | "no_handle"
  | "no_checkpoint"
  | "checkpoint_oversized"
  | "fingerprint_mismatch"
  | "blob_miss"
  | "remote_rejected";

export interface ConversationHandle {
  conversationId: string;
  checkpoint: Uint8Array;
  fingerprint: string;
  blobs: { idHex: string; data: Uint8Array }[];
  /**
   * Sorted-joined names of the MCP tool set last sent on the wire for this
   * conversation. The backend retains the registration across resume requests
   * (PROTOCOL-AGENT §5.1), so a matching key lets the resume omit mcp_tools;
   * a changed set (or a handle predating this field) re-sends the full list.
   */
  toolsetKey?: string;
}

/** Stable identity of a declared tool set, for the resume-omit decision. */
export function toolsetKeyOf(tools: { name: string }[]): string {
  return tools.map((t) => t.name).sort().join("\n");
}

interface HandleFile {
  v: 1;
  conversationId: string;
  checkpoint: string;
  fingerprint: string;
  blobs: { id: string; data: string }[];
  toolsetKey?: string;
}

export function handleDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[HANDLE_DIR_ENV]?.trim();
  if (override) return override;
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "pi", "agent", "cursor-provider", "handles");
}

function safeId(sessionId: string): string {
  const trimmed = sessionId.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed) || trimmed.length > 128) {
    return createHash("sha256").update(trimmed).digest("hex");
  }
  return trimmed;
}

function pathFor(sessionId: string): string {
  return join(handleDir(), `${safeId(sessionId)}.json`);
}

function updateWithImages(h: Hash, images: { data: string; mimeType: string }[] | undefined): void {
  for (const image of images ?? []) {
    h.update("\0img\0");
    h.update(image.mimeType);
    h.update("\0");
    h.update(image.data);
  }
}

function updateWithMessage(h: Hash, msg: IrMessage): void {
  h.update(msg.role);
  h.update("\0");
  if (msg.role === "user") {
    h.update(msg.text ?? "");
    updateWithImages(h, msg.images);
    return;
  }
  if (msg.role === "assistant") {
    // Thinking is excluded: Pi may store or drop thinking blocks independently of
    // what the remote conversation saw, and replay strips them anyway.
    h.update(msg.text ?? "");
    for (const call of msg.toolCalls ?? []) {
      h.update("\0call\0");
      h.update(call.id);
      h.update("\0");
      h.update(call.name);
      h.update("\0");
      h.update(JSON.stringify(call.arguments ?? {}));
    }
    return;
  }
  if (msg.role === "tool" && msg.toolResult) {
    h.update(msg.toolResult.toolCallId);
    h.update("\0");
    const result = msg.toolResult.result;
    h.update(typeof result === "string" ? result : JSON.stringify(result));
    h.update("\0");
    h.update(msg.toolResult.isError ? "1" : "0");
    updateWithImages(h, msg.toolResult.images);
  }
}

/**
 * Fingerprint the full local transcript shape: user text/images exactly, plus
 * assistant text + tool calls and tool results. User-only hashing missed Pi-side
 * compaction, rewind of assistant tails, and tool-result edits while the remote
 * conversation kept the pre-change context.
 */
export function historyFingerprint(messages: IrMessage[]): string {
  const h = createHash("sha256");
  for (const msg of messages) updateWithMessage(h, msg);
  return h.digest("hex");
}

/**
 * Fingerprint at end-of-turn. `messages` is the IR the turn started (or continued)
 * with; the assistant message Pi is about to persist exists only as streamed
 * `events`, so reconstruct it here to keep this comparable to a later
 * `historyFingerprint(history)` over the same turn. Pi persists text blocks and
 * tool calls verbatim from our deltas, so the reconstruction matches 1:1.
 */
export function fingerprintAfterTurn(messages: IrMessage[], events: IrEvent[]): string {
  let text = "";
  const toolCalls: { id: string; name: string; arguments: Record<string, unknown> }[] = [];
  for (const event of events) {
    if (event.type === "text") text += event.delta;
    if (event.type === "tool_call" && event.complete === true) {
      toolCalls.push({ id: event.id, name: event.name, arguments: event.arguments ?? {} });
    }
  }
  const tail: IrMessage[] =
    text !== "" || toolCalls.length > 0
      ? [
          {
            role: "assistant",
            ...(text !== "" ? { text } : {}),
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
          },
        ]
      : [];
  return historyFingerprint([...messages, ...tail]);
}

export function loadHandle(sessionId: string): ConversationHandle | undefined {
  if (sessionId === "") return undefined;
  try {
    const raw = readFileSync(pathFor(sessionId), "utf8");
    const parsed = JSON.parse(raw) as HandleFile;
    if (parsed.v !== 1 || typeof parsed.conversationId !== "string") return undefined;
    const checkpoint = Buffer.from(parsed.checkpoint ?? "", "base64");
    if (checkpoint.byteLength === 0 || checkpoint.byteLength > MAX_CHECKPOINT_BYTES) return undefined;
    const blobs: { idHex: string; data: Uint8Array }[] = [];
    let total = checkpoint.byteLength;
    for (const row of parsed.blobs ?? []) {
      const data = Buffer.from(row.data, "base64");
      total += data.byteLength;
      if (total > MAX_BLOB_STORE_BYTES) return undefined;
      // Content-addressed: a corrupted blob must invalidate the whole handle so the
      // next turn rebuilds, instead of surfacing as a hard error every turn.
      if (typeof row.id !== "string" || createHash("sha256").update(data).digest("hex") !== row.id) {
        return undefined;
      }
      blobs.push({ idHex: row.id, data });
    }
    return {
      conversationId: parsed.conversationId,
      checkpoint,
      fingerprint: parsed.fingerprint,
      blobs,
      ...(typeof parsed.toolsetKey === "string" ? { toolsetKey: parsed.toolsetKey } : {}),
    };
  } catch {
    return undefined;
  }
}

export function saveHandle(sessionId: string, handle: ConversationHandle): void {
  if (sessionId === "") return;
  if (handle.checkpoint.byteLength === 0 || handle.checkpoint.byteLength > MAX_CHECKPOINT_BYTES) return;
  let total = handle.checkpoint.byteLength;
  for (const blob of handle.blobs) {
    total += blob.data.byteLength;
    if (total > MAX_BLOB_STORE_BYTES) return;
  }
  mkdirSync(handleDir(), { recursive: true, mode: 0o700 });
  const body: HandleFile = {
    v: 1,
    conversationId: handle.conversationId,
    checkpoint: Buffer.from(handle.checkpoint).toString("base64"),
    fingerprint: handle.fingerprint,
    blobs: handle.blobs.map((b) => ({
      id: b.idHex,
      data: Buffer.from(b.data).toString("base64"),
    })),
    ...(handle.toolsetKey !== undefined ? { toolsetKey: handle.toolsetKey } : {}),
  };
  // Handle files carry conversation content: write 0600, atomically via rename so a
  // crash mid-write never leaves half a JSON document behind.
  const target = pathFor(sessionId);
  const tmp = `${target}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
}

export function dropHandle(sessionId: string): void {
  if (sessionId === "") return;
  try {
    rmSync(pathFor(sessionId));
  } catch {
    /* missing is fine */
  }
}

export function blobsIntoStore(store: BlobStore, blobs: { idHex: string; data: Uint8Array }[]): void {
  for (const blob of blobs) store.load(blob.idHex, blob.data);
}

export function decideResume(
  sessionId: string,
  history: IrMessage[],
): { resume?: ConversationHandle; reason: RebuildReason | "resume" } {
  const stored = loadHandle(sessionId);
  if (!stored) return { reason: "no_handle" };
  if (stored.checkpoint.byteLength === 0) return { reason: "no_checkpoint" };
  if (stored.checkpoint.byteLength > MAX_CHECKPOINT_BYTES) return { reason: "checkpoint_oversized" };
  if (stored.fingerprint !== historyFingerprint(history)) return { reason: "fingerprint_mismatch" };
  return { resume: stored, reason: "resume" };
}

export function remoteLooksStale(error: unknown): boolean {
  if (isStaleRemote(error)) return true;
  const text = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    text.includes("not_found") ||
    text.includes("invalid_argument") ||
    text.includes("failed_precondition") ||
    text.includes("conversation")
  );
}

export { staleRemoteError };
