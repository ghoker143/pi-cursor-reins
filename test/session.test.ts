// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { EXEC_DRIFT_MESSAGE } from "../src/errors.ts";
import { applyServerMessage, createMapper } from "../src/session/events.ts";
import { buildStreamRequest, estimateTokens, truncateHistory } from "../src/session/request.ts";
import { rejectExecFrame } from "../src/proto/inference.ts";
import type { ServerMessage } from "../src/proto/inference.ts";
import type { InferenceIR } from "../src/session/ir.ts";

function ir(over: Partial<InferenceIR> = {}): InferenceIR {
  return {
    sessionId: "s",
    systemPrompt: "sys",
    messages: [{ role: "user", text: "hello" }],
    tools: [{ name: "echo", description: "d", jsonSchema: { type: "object" } }],
    modelId: "composer-2.5",
    maxMode: false,
    contextWindow: 200_000,
    ...over,
  };
}

test("T-SESSION: IR snapshot includes system + tools jsonSchema wrap fields", () => {
  const req = buildStreamRequest(ir(), "inv");
  assert.equal(req.messages[0]?.role, 4);
  assert.equal(req.tools[0]?.jsonSchema.type, "object");
  assert.equal(req.invocationId, "inv");
});

test("T-SESSION: text + tool_call stream maps to IR events and stopReason toolUse", () => {
  const state = createMapper();
  applyServerMessage(state, {
    case: "invocationResponse",
    invocationId: "i",
    response: { case: "textPart", value: { text: "hi", isFinal: true } },
  });
  applyServerMessage(state, {
    case: "invocationResponse",
    invocationId: "i",
    response: {
      case: "toolCallPart",
      value: { toolCallId: "t1", toolName: "echo", args: "", isComplete: false },
    },
  });
  applyServerMessage(state, {
    case: "invocationResponse",
    invocationId: "i",
    response: {
      case: "toolCallPart",
      value: { toolCallId: "t1", toolName: "echo", args: '{"x":1}', isComplete: true },
    },
  });
  applyServerMessage(state, { case: "invocationEnd", value: { invocationId: "i" } });
  assert.equal(state.stopReason, "toolUse");
  assert.equal(state.events.some((e) => e.type === "tool_call" && "complete" in e && e.complete), true);
});

test("T-FR2.b: forged exec frame is fail-closed", () => {
  assert.throws(() => rejectExecFrame({ execServerMessage: { command: "bash" } }), (err: Error) => {
    assert.match(err.message, new RegExp(EXEC_DRIFT_MESSAGE));
    return true;
  });
  const state = createMapper();
  assert.throws(
    () => applyServerMessage(state, { case: "unknown", field: 9 }),
    (err: Error) => {
      assert.match(err.message, new RegExp(EXEC_DRIFT_MESSAGE));
      return true;
    },
  );
});

test("T-SESSION: truncation emits warning and keeps system prompt", () => {
  const { ir: out, warning } = truncateHistory(
    ir({
      contextWindow: 10,
      messages: [
        { role: "user", text: "a".repeat(80) },
        { role: "assistant", text: "b".repeat(80) },
        { role: "user", text: "c" },
      ],
    }),
  );
  assert.ok(warning);
  assert.equal(out.systemPrompt, "sys");
  assert.ok(out.messages.length < 3 || out.messages[0]?.text === "c");
});

test("T-SESSION: truncation cuts at a user-turn boundary (no orphan tool/assistant replay)", () => {
  const { ir: out } = truncateHistory(
    ir({
      contextWindow: 30,
      messages: [
        { role: "user", text: "a".repeat(100) },
        { role: "assistant", toolCalls: [{ id: "t1", name: "echo", arguments: { q: "x" } }] },
        { role: "tool", toolResult: { toolCallId: "t1", toolName: "echo", result: "r", isError: false } },
        { role: "user", text: "c" },
      ],
    }),
  );
  assert.equal(out.messages[0]?.role, "user", "replay must start at a user turn");
  assert.deepEqual(
    out.messages.map((m) => m.role),
    ["user"],
  );
});

test("T-SESSION: image-heavy transcripts estimate per image, not per base64 char", () => {
  const withImage = ir({
    messages: [{ role: "user", text: "look", images: [{ data: "A".repeat(100_000), mimeType: "image/png" }] }],
  });
  const tokens = estimateTokens(withImage);
  assert.ok(tokens < 2_000, `image must count ~1200 tokens, got ${String(tokens)}`);
});

test("T-SESSION: tool args streamed as deltas are assembled at is_complete", () => {
  const mapper = createMapper();
  const part = (args: string, isComplete: boolean, toolName = "read"): ServerMessage => ({
    case: "invocationResponse",
    invocationId: "inv",
    response: { case: "toolCallPart", value: { toolCallId: "c1", toolName, args, isComplete } },
  });
  applyServerMessage(mapper, part('{"path":', false));
  applyServerMessage(mapper, part('"/tmp/a"', false, ""));
  applyServerMessage(mapper, part("}", true, ""));
  const complete = mapper.events.find((e) => e.type === "tool_call" && e.complete === true);
  assert.ok(complete && complete.type === "tool_call");
  assert.deepEqual(complete.arguments, { path: "/tmp/a" });
  assert.equal(mapper.openTools.size, 0);
});

test("T-SESSION: complete frame repeating full args after deltas still parses", () => {
  const mapper = createMapper();
  const part = (args: string, isComplete: boolean): ServerMessage => ({
    case: "invocationResponse",
    invocationId: "inv",
    response: { case: "toolCallPart", value: { toolCallId: "c2", toolName: "read", args, isComplete } },
  });
  applyServerMessage(mapper, part('{"path":', false));
  applyServerMessage(mapper, part('{"path":"/tmp/a"}', true));
  const complete = mapper.events.find((e) => e.type === "tool_call" && e.complete === true);
  assert.ok(complete && complete.type === "tool_call");
  assert.deepEqual(complete.arguments, { path: "/tmp/a" });
});
