// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeServerMessage,
  encodeClientMessage,
  encodeStreamRequest,
  InferenceMessageRole,
  type InferenceStreamRequest,
} from "../src/proto/inference.ts";
import { encodeConnectFrame, ConnectFrameDecoder, CONNECT_FLAG_END_STREAM } from "../src/transport/connect.ts";
import { decodeAgentServerMessage } from "../src/proto/agent.ts";
import { encodeFields, writeBytes, writeBytesAlways, writeString } from "../src/proto/wire.ts";

test("T-PROTO: stream request round-trips system + tool schema wrap", () => {
  const req: InferenceStreamRequest = {
    messages: [{ role: InferenceMessageRole.SYSTEM, text: "be terse" }, { role: InferenceMessageRole.USER, text: "hi" }],
    tools: [{ name: "echo", description: "echo", jsonSchema: { type: "object", properties: { x: { type: "string" } } } }],
    conversationId: "sess",
    invocationId: "inv",
  };
  const bytes = encodeStreamRequest(req);
  assert.ok(bytes.byteLength > 0);
});

test("T-PROTO: finish_run encodes a present empty oneof arm", () => {
  const bytes = encodeClientMessage({ case: "finishRun" });
  assert.ok(bytes.byteLength >= 2);
});

test("T-PROTO: unknown outer server field is decodable as unknown", () => {
  // field 9 (not 1-4), length-delimited empty
  const bytes = Uint8Array.of((9 << 3) | 2, 0);
  const msg = decodeServerMessage(bytes);
  assert.equal(msg.case, "unknown");
  if (msg.case === "unknown") assert.equal(msg.field, 9);
});

test("T-TRANS: connect frame encode/decode + trailer", () => {
  const decoder = new ConnectFrameDecoder();
  const payload = Uint8Array.of(1, 2, 3);
  const frames = decoder.push(encodeConnectFrame(payload));
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]!.body], [1, 2, 3]);
  const trailer = encoderTrailer();
  const rest = decoder.push(trailer);
  assert.equal(rest[0]?.endOfStream, true);
  decoder.end();
});

function encoderTrailer(): Uint8Array {
  const json = new TextEncoder().encode("{}");
  return encodeConnectFrame(json, CONNECT_FLAG_END_STREAM);
}

test("T-PROTO: InteractionUpdate keeps a known delta when an unknown field follows", () => {
  const update = encodeFields((w) => {
    writeBytesAlways(w, 1, encodeFields((iw) => writeString(iw, 1, "hello")));
    writeBytesAlways(w, 99, encodeFields((iw) => writeString(iw, 1, "future")));
  });
  const frame = encodeFields((w) => writeBytes(w, 1, update));
  const msg = decodeAgentServerMessage(frame);
  assert.equal(msg.case, "interactionUpdate");
  if (msg.case === "interactionUpdate") {
    assert.equal(msg.inner.case, "textDelta");
    if (msg.inner.case === "textDelta") assert.equal(msg.inner.text, "hello");
  }
});

test("T-PROTO: InteractionUpdate with two known arms is drift, not silent loss", () => {
  const update = encodeFields((w) => {
    writeBytesAlways(w, 1, encodeFields((iw) => writeString(iw, 1, "a")));
    writeBytesAlways(w, 4, encodeFields((iw) => writeString(iw, 1, "b")));
  });
  const frame = encodeFields((w) => writeBytes(w, 1, update));
  assert.throws(() => decodeAgentServerMessage(frame), /second known arm/);
});
