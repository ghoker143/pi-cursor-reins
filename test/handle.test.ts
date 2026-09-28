// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HANDLE_DIR_ENV } from "../src/constants.ts";
import {
  decideResume,
  dropHandle,
  fingerprintAfterTurn,
  historyFingerprint,
  loadHandle,
  saveHandle,
} from "../src/agent/handle-store.ts";
import { overlayCheckpointState } from "../src/proto/agent.ts";
import { encodeFields, expectBytes, forEachField, skipUnknown, writeBytes, writeString } from "../src/proto/wire.ts";
import type { IrEvent, IrMessage } from "../src/session/ir.ts";

function users(...texts: string[]): IrMessage[] {
  return texts.map((text) => ({ role: "user" as const, text }));
}

test("T-HANDLE: fingerprint covers assistant and tool sides, not just user text", () => {
  const base = historyFingerprint([...users("one"), { role: "assistant", text: "ok" }]);
  assert.notEqual(
    base,
    historyFingerprint([...users("one"), { role: "assistant", text: "changed" }]),
    "assistant text edits must invalidate the remote handle",
  );
  assert.notEqual(
    base,
    historyFingerprint(users("one")),
    "a rewound assistant tail must invalidate the remote handle",
  );
  const withTool = historyFingerprint([
    ...users("one"),
    { role: "assistant", toolCalls: [{ id: "c1", name: "read", arguments: { path: "a" } }] },
    { role: "tool", toolResult: { toolCallId: "c1", toolName: "read", result: "body", isError: false } },
  ]);
  const editedResult = historyFingerprint([
    ...users("one"),
    { role: "assistant", toolCalls: [{ id: "c1", name: "read", arguments: { path: "a" } }] },
    { role: "tool", toolResult: { toolCallId: "c1", toolName: "read", result: "truncated", isError: false } },
  ]);
  assert.notEqual(withTool, editedResult, "tool-result edits must invalidate the remote handle");
  assert.notEqual(historyFingerprint(users("one")), historyFingerprint(users("one", "two")));
});

test("T-HANDLE: fingerprintAfterTurn reconstructs the streamed assistant tail", () => {
  const messages: IrMessage[] = users("ping");
  const events: IrEvent[] = [
    { type: "text", delta: "po" },
    { type: "thinking", delta: "hmm" },
    { type: "text", delta: "ng" },
    { type: "usage", input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    { type: "done", stopReason: "stop" },
  ];
  const stored = fingerprintAfterTurn(messages, events);
  const nextTurnHistory: IrMessage[] = [...users("ping"), { role: "assistant", text: "pong" }];
  assert.equal(stored, historyFingerprint(nextTurnHistory));
});

test("T-HANDLE: fingerprint includes user image bytes", () => {
  const textOnly = historyFingerprint([{ role: "user", text: "look" }]);
  const withImage = historyFingerprint([
    { role: "user", text: "look", images: [{ data: "aaa", mimeType: "image/png" }] },
  ]);
  const otherImage = historyFingerprint([
    { role: "user", text: "look", images: [{ data: "bbb", mimeType: "image/png" }] },
  ]);
  assert.notEqual(textOnly, withImage);
  assert.notEqual(withImage, otherImage);
});

test("T-HANDLE: save/load round-trip and stale mismatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "pcn-handle-"));
  const prev = process.env[HANDLE_DIR_ENV];
  process.env[HANDLE_DIR_ENV] = dir;
  try {
    const checkpoint = Uint8Array.of(1, 2, 3, 4);
    const blobData = Uint8Array.of(9);
    const blobId = createHash("sha256").update(blobData).digest("hex");
    saveHandle("sess-1", {
      conversationId: "conv-1",
      checkpoint,
      fingerprint: historyFingerprint(users("hello")),
      blobs: [{ idHex: blobId, data: blobData }],
    });
    if (process.platform !== "win32") {
      assert.equal(statSync(join(dir, "sess-1.json")).mode & 0o777, 0o600, "handle files carry conversation content");
    }
    const loaded = loadHandle("sess-1");
    assert.equal(loaded?.conversationId, "conv-1");
    assert.deepEqual([...loaded!.checkpoint], [1, 2, 3, 4]);
    const ok = decideResume("sess-1", users("hello"));
    assert.equal(ok.reason, "resume");
    const stale = decideResume("sess-1", users("hello", "edited"));
    assert.equal(stale.reason, "fingerprint_mismatch");
    assert.equal(stale.resume, undefined);
    dropHandle("sess-1");
    assert.equal(decideResume("sess-1", users("hello")).reason, "no_handle");
  } finally {
    if (prev === undefined) delete process.env[HANDLE_DIR_ENV];
    else process.env[HANDLE_DIR_ENV] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-HANDLE: a corrupted blob invalidates the handle instead of erroring every turn", () => {
  const dir = mkdtempSync(join(tmpdir(), "pcn-handle-"));
  const prev = process.env[HANDLE_DIR_ENV];
  process.env[HANDLE_DIR_ENV] = dir;
  try {
    saveHandle("sess-2", {
      conversationId: "conv-2",
      checkpoint: Uint8Array.of(1),
      fingerprint: historyFingerprint(users("hello")),
      blobs: [{ idHex: "deadbeef", data: Uint8Array.of(9) }],
    });
    assert.equal(loadHandle("sess-2"), undefined);
    assert.equal(decideResume("sess-2", users("hello")).reason, "no_handle");
  } finally {
    if (prev === undefined) delete process.env[HANDLE_DIR_ENV];
    else process.env[HANDLE_DIR_ENV] = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("T-HANDLE: overlay keeps journal turns and checkpoint prompt", () => {
  const turn = Uint8Array.of(9, 9, 9);
  const oldPrompt = new Uint8Array(32).fill(1);
  const checkpoint = encodeFields((w) => {
    writeBytes(w, 1, oldPrompt);
    writeBytes(w, 8, turn);
    writeString(w, 22, "old");
  });
  const overlay = overlayCheckpointState(checkpoint, {
    rootPromptBlobIds: [new Uint8Array(32).fill(7)],
    workspaceUri: "file:///tmp/ws",
  });
  const prompts: number[] = [];
  let sawTurn = false;
  let client = "";
  forEachField(overlay, (field, wire, reader) => {
    if (field === 1) {
      prompts.push(expectBytes(reader, wire)[0] ?? -1);
    } else if (field === 8) {
      sawTurn = expectBytes(reader, wire)[0] === 9;
    } else if (field === 22) {
      client = new TextDecoder().decode(expectBytes(reader, wire));
    } else skipUnknown(reader, wire, field);
  });
  assert.deepEqual(prompts, [7, 1]);
  assert.equal(sawTurn, true);
  assert.equal(client, "pi");
});
