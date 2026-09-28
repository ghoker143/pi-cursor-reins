// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Http2Server, type ServerHttp2Stream } from "node:http2";
import { test } from "node:test";
import { HANDLE_DIR_ENV, LOCAL_TOOL_ESCALATE_AFTER, MAX_LOCAL_TOOL_REJECTIONS, MAX_MCP_RESULT_CHARS } from "../src/constants.ts";
import { LOCAL_TOOL_LOOP_MESSAGE, NATIVE_EXEC_REJECT } from "../src/errors.ts";
import { loadHandle } from "../src/agent/handle-store.ts";
import { encodeConnectFrame, ConnectFrameDecoder, CONNECT_FLAG_END_STREAM } from "../src/transport/connect.ts";
import { decodeAgentServerMessage } from "../src/proto/agent.ts";
import { jsonToValueBytes } from "../src/proto/struct.ts";
import {
  encodeFields,
  expectBytes,
  expectString,
  expectVarint,
  forEachField,
  skipUnknown,
  WireType,
  writeBytes,
  writeBytesAlways,
  writeString,
  writeUint32,
  writeUint32Always,
} from "../src/proto/wire.ts";
import { runAgentSession, __resetAgentRunsForTests } from "../src/agent/index.ts";
import type { InferenceIR, IrEvent } from "../src/session/ir.ts";

process.env[HANDLE_DIR_ENV] = mkdtempSync(join(tmpdir(), "pcn-agent-session-"));

function ir(over: Partial<InferenceIR> = {}): InferenceIR {
  return {
    sessionId: "sess-agent",
    systemPrompt: "sys",
    messages: [{ role: "user", text: "ping" }],
    tools: [{ name: "echo", description: "echo", jsonSchema: { type: "object", properties: { x: { type: "string" } } } }],
    modelId: "composer-2.5",
    maxMode: false,
    contextWindow: 200_000,
    ...over,
  };
}

function encodeUpdate(innerField: number, inner: Uint8Array): Uint8Array {
  return encodeFields((w) => {
    writeBytes(
      w,
      1,
      encodeFields((uw) => writeBytesAlways(uw, innerField, inner)),
    );
  });
}

function textDelta(text: string): Uint8Array {
  return encodeUpdate(1, encodeFields((w) => writeString(w, 1, text)));
}

function thinkingDelta(text: string): Uint8Array {
  return encodeUpdate(4, encodeFields((w) => writeString(w, 1, text)));
}

function tokenDelta(tokens: number): Uint8Array {
  return encodeUpdate(8, encodeFields((w) => writeUint32(w, 1, tokens)));
}

function turnEnded(): Uint8Array {
  return encodeUpdate(14, new Uint8Array());
}

function mcpArgsFrame(toolName: string, toolCallId: string, args: Record<string, unknown>): Uint8Array {
  const mcp = encodeFields((w) => {
    writeString(w, 1, toolName);
    for (const [k, v] of Object.entries(args)) {
      writeBytes(
        w,
        2,
        encodeFields((ew) => {
          writeString(ew, 1, k);
          writeBytes(ew, 2, jsonToValueBytes(v));
        }),
      );
    }
    writeString(w, 3, toolCallId);
    writeString(w, 4, "pi");
    writeString(w, 5, toolName);
  });
  const exec = encodeFields((w) => {
    writeUint32(w, 1, 7);
    writeBytes(w, 11, mcp);
    writeString(w, 15, "exec-1");
  });
  return encodeFields((w) => writeBytes(w, 2, exec));
}

async function listen(): Promise<{
  origin: string;
  server: Http2Server;
  onStream: (fn: (stream: ServerHttp2Stream) => void) => void;
}> {
  const server = createServer();
  let handler: ((stream: ServerHttp2Stream) => void) | undefined;
  server.on("stream", (stream, headers) => {
    assert.equal(headers[":path"], "/agent.v1.AgentService/Run");
    handler?.(stream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  return {
    origin: `http://127.0.0.1:${String(addr.port)}`,
    server,
    onStream: (fn) => {
      handler = fn;
    },
  };
}

function writeProto(stream: ServerHttp2Stream, body: Uint8Array): void {
  stream.write(encodeConnectFrame(body));
}

function writeTrailer(stream: ServerHttp2Stream): void {
  stream.end(encodeConnectFrame(new TextEncoder().encode("{}"), CONNECT_FLAG_END_STREAM));
}

function checkpointFrame(bytes: Uint8Array): Uint8Array {
  return encodeFields((w) => writeBytesAlways(w, 3, bytes));
}

/** Pull run_request.conversation_id (run field 5, outer field 1) off a client frame. */
function conversationIdOf(body: Uint8Array): string | undefined {
  let id: string | undefined;
  forEachField(body, (field, wire, reader) => {
    if (field !== 1) {
      skipUnknown(reader, wire, field);
      return;
    }
    forEachField(expectBytes(reader, wire), (f, w, r) => {
      if (f === 5) id = expectString(r, w);
      else skipUnknown(r, w, f);
    });
  });
  return id;
}

test("T-AGENT-SESSION: local h2 text turn maps to IR stop", async () => {
  __resetAgentRunsForTests();
  const fake = await listen();
  fake.onStream((stream) => {
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    const decoder = new ConnectFrameDecoder();
    stream.on("data", (chunk: Uint8Array) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.endOfStream) continue;
        writeProto(stream, textDelta("pong"));
        writeProto(stream, turnEnded());
        writeTrailer(stream);
      }
    });
  });
  try {
    const result = await runAgentSession({
      token: "tok",
      ir: ir(),
      origin: fake.origin,
    });
    assert.equal(
      result.events.some((e) => e.type === "text" && e.delta === "pong"),
      true,
    );
    const done = result.events.find((e) => e.type === "done");
    assert.equal(done && done.type === "done" ? done.stopReason : "", "stop");
  } finally {
    fake.server.close();
    __resetAgentRunsForTests();
  }
});

test("T-AGENT-SESSION: thinking/text deltas fan out live before the turn ends; usage carries an input estimate", async () => {
  __resetAgentRunsForTests();
  const fake = await listen();
  let turnEndSentAt = 0;
  fake.onStream((stream) => {
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    const decoder = new ConnectFrameDecoder();
    stream.on("data", (chunk: Uint8Array) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.endOfStream) continue;
        writeProto(stream, thinkingDelta("pondering"));
        writeProto(stream, textDelta("pong"));
        writeProto(stream, tokenDelta(7));
        setTimeout(() => {
          turnEndSentAt = performance.now();
          writeProto(stream, turnEnded());
          writeTrailer(stream);
        }, 40);
      }
    });
  });
  try {
    let thinkingAt = 0;
    let textAt = 0;
    const live: IrEvent[] = [];
    const result = await runAgentSession({
      token: "tok",
      ir: ir(),
      origin: fake.origin,
      onEvent: (event) => {
        if (event.type === "thinking") thinkingAt = performance.now();
        if (event.type === "text" && event.delta === "pong") textAt = performance.now();
        live.push(event);
      },
    });
    assert.ok(thinkingAt > 0, "thinking delta streamed");
    assert.ok(textAt > 0, "text delta streamed");
    assert.ok(thinkingAt < turnEndSentAt, "thinking arrived before turnEnded was sent");
    assert.ok(textAt < turnEndSentAt, "text arrived before turnEnded was sent");
    const usage = result.events.find((e) => e.type === "usage");
    assert.ok(usage && usage.type === "usage");
    assert.equal(usage.output, 7);
    assert.ok(usage.input > 0, "usage.input must estimate the prompt, not report 0");
    const done = result.events.find((e) => e.type === "done");
    assert.equal(done && done.type === "done" ? done.stopReason : "", "stop");
    assert.ok(live.some((e) => e.type === "usage" && e.input > 0), "usage fans out live");
    assert.ok(live.some((e) => e.type === "done" && e.stopReason === "stop"), "done fans out live");
  } finally {
    fake.server.close();
    __resetAgentRunsForTests();
  }
});

test("T-AGENT-SESSION: mcpArgs lifts to Pi toolCall and mcp_result continues the stream", async () => {
  __resetAgentRunsForTests();
  const fake = await listen();
  let phase: "await-run" | "await-result" | "done" = "await-run";
  fake.onStream((stream) => {
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    const decoder = new ConnectFrameDecoder();
    stream.on("data", (chunk: Uint8Array) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.endOfStream) continue;
        if (phase === "await-run") {
          writeProto(stream, mcpArgsFrame("echo", "call-1", { x: "1" }));
          phase = "await-result";
          return;
        }
        if (phase === "await-result") {
          const msg = decodeAgentServerMessage(frame.body);
          assert.notEqual(msg.case, "unknown");
          writeProto(stream, textDelta("echoed"));
          writeProto(stream, turnEnded());
          writeTrailer(stream);
          phase = "done";
        }
      }
    });
  });

  try {
    const live1: IrEvent[] = [];
    const first = await runAgentSession({
      token: "tok",
      ir: ir(),
      origin: fake.origin,
      onEvent: (event) => live1.push(event),
    });
    const call = first.events.find((e) => e.type === "tool_call");
    assert.ok(call && call.type === "tool_call");
    assert.equal(call.name, "echo");
    assert.equal(call.id, "call-1");
    const done = first.events.find((e) => e.type === "done");
    assert.equal(done && done.type === "done" ? done.stopReason : "", "toolUse");
    assert.ok(
      live1.some((e) => e.type === "tool_call" && e.name === "echo"),
      "tool call fans out live on the first leg",
    );

    const live2: IrEvent[] = [];
    const second = await runAgentSession({
      token: "tok",
      ir: ir({
        messages: [
          { role: "user", text: "ping" },
          { role: "assistant", toolCalls: [{ id: "call-1", name: "echo", arguments: { x: "1" } }] },
          { role: "tool", toolResult: { toolCallId: "call-1", toolName: "echo", result: "1", isError: false } },
        ],
      }),
      origin: fake.origin,
      onEvent: (event) => live2.push(event),
    });
    assert.equal(
      second.events.some((e) => e.type === "text" && e.delta === "echoed"),
      true,
    );
    assert.ok(
      live2.some((e) => e.type === "text" && e.delta === "echoed"),
      "continuation leg streams into the new sink",
    );
  } finally {
    fake.server.close();
    __resetAgentRunsForTests();
  }
});

test("T-AGENT-SESSION: resumed turn without a fresh checkpoint keeps the previous handle", async () => {
  __resetAgentRunsForTests();
  const fake = await listen();
  let streamNo = 0;
  const seenConversationIds: (string | undefined)[] = [];
  const checkpointA = encodeFields((w) => writeString(w, 22, "cp-a"));
  const checkpointB = encodeFields((w) => writeString(w, 22, "cp-b"));
  fake.onStream((stream) => {
    streamNo += 1;
    const mine = streamNo;
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    const decoder = new ConnectFrameDecoder();
    stream.on("data", (chunk: Uint8Array) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.endOfStream) continue;
        seenConversationIds.push(conversationIdOf(frame.body));
        if (mine === 1) writeProto(stream, checkpointFrame(checkpointA));
        if (mine === 3) writeProto(stream, checkpointFrame(checkpointB));
        // Stream 2 deliberately sends NO checkpoint frame: the turn ends on a stale
        // checkpoint and the handle must not advance.
        writeProto(stream, textDelta(mine === 1 ? "pong" : `pong-${String(mine)}`));
        writeProto(stream, turnEnded());
        writeTrailer(stream);
      }
    });
  });
  try {
    await runAgentSession({ token: "tok", ir: ir({ sessionId: "sess-c1" }), origin: fake.origin });
    const first = loadHandle("sess-c1");
    assert.ok(first, "fresh turn with a checkpoint persists a handle");

    // Turn 2 resumes (fingerprint matches) but the server sends no new checkpoint.
    await runAgentSession({
      token: "tok",
      ir: ir({
        sessionId: "sess-c1",
        messages: [
          { role: "user", text: "ping" },
          { role: "assistant", text: "pong" },
          { role: "user", text: "two" },
        ],
      }),
      origin: fake.origin,
    });
    assert.equal(seenConversationIds[1], first.conversationId, "turn 2 must resume the remote conversation");
    const second = loadHandle("sess-c1");
    assert.deepEqual(second?.fingerprint, first.fingerprint, "stale checkpoint must not carry a new fingerprint");
    assert.deepEqual(second ? [...second.checkpoint] : [], [...checkpointA]);

    // Turn 3 now mismatches the stale handle and rebuilds; a fresh checkpoint there
    // persists normally again.
    await runAgentSession({
      token: "tok",
      ir: ir({
        sessionId: "sess-c1",
        messages: [
          { role: "user", text: "ping" },
          { role: "assistant", text: "pong" },
          { role: "user", text: "two" },
          { role: "assistant", text: "pong-2" },
          { role: "user", text: "three" },
        ],
      }),
      origin: fake.origin,
    });
    assert.notEqual(seenConversationIds[2], first.conversationId, "turn 3 rebuilds with a new conversation");
    const third = loadHandle("sess-c1");
    assert.ok(third);
    assert.notEqual(third.fingerprint, first.fingerprint);
    assert.deepEqual([...third.checkpoint], [...checkpointB]);
  } finally {
    fake.server.close();
    __resetAgentRunsForTests();
  }
});

test("T-AGENT-SESSION: toolUse watchdog destroys a run Pi never continues", async () => {
  __resetAgentRunsForTests();
  const prev = process.env.CURSOR_PROVIDER_TOOLUSE_WATCHDOG_MS;
  process.env.CURSOR_PROVIDER_TOOLUSE_WATCHDOG_MS = "80";
  const fake = await listen();
  let streamNo = 0;
  fake.onStream((stream) => {
    streamNo += 1;
    const mine = streamNo;
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    const decoder = new ConnectFrameDecoder();
    stream.on("data", (chunk: Uint8Array) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.endOfStream) continue;
        if (mine === 1) {
          // Ask for a tool, then go silent: the watchdog must reap this run.
          writeProto(stream, mcpArgsFrame("echo", "call-w", { x: "1" }));
          return;
        }
        writeProto(stream, textDelta("recovered"));
        writeProto(stream, turnEnded());
        writeTrailer(stream);
      }
    });
  });
  try {
    const first = await runAgentSession({
      token: "tok",
      ir: ir({ sessionId: "sess-watchdog" }),
      origin: fake.origin,
    });
    const done = first.events.find((e) => e.type === "done");
    assert.equal(done && done.type === "done" ? done.stopReason : "", "toolUse");

    await new Promise((resolve) => setTimeout(resolve, 300));

    const second = await runAgentSession({
      token: "tok",
      ir: ir({
        sessionId: "sess-watchdog",
        messages: [
          { role: "user", text: "ping" },
          { role: "assistant", toolCalls: [{ id: "call-w", name: "echo", arguments: { x: "1" } }] },
          { role: "tool", toolResult: { toolCallId: "call-w", toolName: "echo", result: "1", isError: false } },
        ],
      }),
      origin: fake.origin,
    });
    const secondDone = second.events.find((e) => e.type === "done");
    assert.equal(secondDone && secondDone.type === "done" ? secondDone.stopReason : "", "stop");
    assert.equal(streamNo, 2, "watchdog must have destroyed the parked run; continuation opens a fresh stream");
  } finally {
    if (prev === undefined) delete process.env.CURSOR_PROVIDER_TOOLUSE_WATCHDOG_MS;
    else process.env.CURSOR_PROVIDER_TOOLUSE_WATCHDOG_MS = prev;
    fake.server.close();
    __resetAgentRunsForTests();
  }
});

/** ExecServerMessage carrying a native oneof arm this build classifies (shell_args = field 2). */
function shellArgsFrame(command: string, id: number, execId = "exec-native"): Uint8Array {
  const payload = encodeFields((w) => writeString(w, 1, command));
  const exec = encodeFields((w) => {
    writeUint32Always(w, 1, id);
    writeBytesAlways(w, 2, payload);
    writeString(w, 15, execId);
  });
  return encodeFields((w) => writeBytes(w, 2, exec));
}

/** ExecServerMessage whose oneof arm is a field number this build does not know (proto drift). */
function unknownExecFrame(id: number, armField = 99): Uint8Array {
  const arm = encodeFields((w) => writeString(w, 1, "future native tool"));
  const exec = encodeFields((w) => {
    writeUint32Always(w, 1, id);
    writeBytesAlways(w, armField, arm);
  });
  return encodeFields((w) => writeBytes(w, 2, exec));
}

/** Cursor plan-mode request (`start_grind_planning_args` = exec arm 36), no exec_id. */
function planningArgsFrame(id: number): Uint8Array {
  const exec = encodeFields((w) => {
    writeUint32Always(w, 1, id);
    writeBytesAlways(w, 36, encodeFields(() => undefined));
  });
  return encodeFields((w) => writeBytes(w, 2, exec));
}

interface ExecReply {
  id: number;
  resultField: number;
  resultBytes: Uint8Array;
}

/** Decode an ExecClientMessage (`exec_client_message` = outer field 2). */
function execReplyOf(body: Uint8Array): ExecReply {
  const out: ExecReply = { id: -1, resultField: -1, resultBytes: new Uint8Array() };
  forEachField(body, (field, wire, reader) => {
    if (field !== 2) {
      skipUnknown(reader, wire, field);
      return;
    }
    forEachField(expectBytes(reader, wire), (f, w, r) => {
      if (f === 1) out.id = expectVarint(r, w);
      else if (w === WireType.LengthDelimited && out.resultField < 0) {
        out.resultField = f;
        out.resultBytes = new Uint8Array(expectBytes(r, w));
      } else skipUnknown(r, w, f);
    });
  });
  return out;
}

/** Field number of the (single) arm inside an encoded result message. */
function firstInnerField(bytes: Uint8Array): number {
  let field = -1;
  forEachField(bytes, (f, w, r) => {
    field = f;
    skipUnknown(r, w, f);
  });
  return field;
}

function replyContains(body: Uint8Array, needle: string): boolean {
  return new TextDecoder().decode(body).includes(needle);
}

/** id of an ExecClientMessage (`exec_client_message` = outer field 2). */
function execReplyId(body: Uint8Array): number {
  let id = -1;
  forEachField(body, (field, wire, reader) => {
    if (field !== 2) {
      skipUnknown(reader, wire, field);
      return;
    }
    forEachField(expectBytes(reader, wire), (f, w, r) => {
      if (f === 1) id = expectVarint(r, w);
      else skipUnknown(r, w, f);
    });
  });
  return id;
}

/**
 * Answer the opening client frame with `frames`, then collect later client frames.
 * `endAfter` terminates the turn (text + turn_ended + trailer) once that many client
 * replies have arrived, so the run settles instead of parking on its idle timer.
 */
function serveFrames(frames: Uint8Array[], opts: { endAfter?: number; onReply?: (body: Uint8Array) => void } = {}) {
  const endAfter = opts.endAfter ?? Number.POSITIVE_INFINITY;
  return (stream: ServerHttp2Stream): void => {
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    const decoder = new ConnectFrameDecoder();
    let opened = false;
    let replies = 0;
    let ended = false;
    stream.on("data", (chunk: Uint8Array) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.endOfStream) continue;
        if (!opened) {
          opened = true;
          for (const out of frames) writeProto(stream, out);
          continue;
        }
        opts.onReply?.(frame.body);
        replies += 1;
        if (!ended && replies >= endAfter) {
          ended = true;
          writeProto(stream, textDelta("settled"));
          writeProto(stream, turnEnded());
          writeTrailer(stream);
        }
      }
    });
  };
}

test("T-AGENT-SESSION: a native exec is rejected in-band and never becomes a Pi tool call", async () => {
  __resetAgentRunsForTests();
  const fake = await listen();
  const replies: Uint8Array[] = [];
  fake.onStream(
    serveFrames([shellArgsFrame("ls -la", 1)], {
      endAfter: 1,
      onReply: (body) => replies.push(body),
    }),
  );
  try {
    const result = await runAgentSession({ token: "tok", ir: ir({ sessionId: "sess-reject" }), origin: fake.origin });
    assert.equal(replies.length, 1, "exactly one typed reject comes back for one native exec");
    const reply = replies[0]!;
    assert.equal(execReplyId(reply), 1, "the reject echoes the exec id");
    assert.ok(replyContains(reply, NATIVE_EXEC_REJECT), "the reject says no operation was performed");
    assert.ok(replyContains(reply, "mcp_pi_echo"), "the reject names a registered Pi MCP tool");
    assert.ok(replyContains(reply, "exec-native"), "the reject echoes the exec_id");
    assert.equal(
      result.events.some((e) => e.type === "tool_call"),
      false,
      "a rejected native exec must never surface as a Pi tool call",
    );
  } finally {
    fake.server.close();
    __resetAgentRunsForTests();
  }
});

test("T-AGENT-SESSION: repeated native rejects escalate the redirect before failing closed", async () => {
  __resetAgentRunsForTests();
  const fake = await listen();
  const replies: Uint8Array[] = [];
  fake.onStream(
    serveFrames([1, 2, 3, 4].map((n) => shellArgsFrame(`echo ${String(n)}`, n)), {
      endAfter: 4,
      onReply: (body) => replies.push(body),
    }),
  );
  try {
    const result = await runAgentSession({
      token: "tok",
      ir: ir({ sessionId: "sess-escalate" }),
      origin: fake.origin,
    });
    assert.equal(replies.length, 4, "every miss before the budget is answered in-band");
    assert.ok(!replyContains(replies[0]!, "STOP calling"), "the first redirect explains, it does not shout");
    const escalated = replies[LOCAL_TOOL_ESCALATE_AFTER]!;
    assert.ok(replyContains(escalated, "STOP calling Cursor native tools"), "guidance hardens once it is ignored");
    assert.ok(replyContains(escalated, "mcp_pi_echo"), "even the hardened redirect keeps a concrete tool name");
    assert.equal(result.events.some((e) => e.type === "tool_call"), false);
  } finally {
    fake.server.close();
    __resetAgentRunsForTests();
  }
});

for (const [label, kind] of [
  ["native exec", "native"],
  ["unknown exec arm", "unknown"],
  ["unregistered MCP name", "notfound"],
] as const) {
  test(`T-AGENT-SESSION: ${label} misses are bounded by the loop guard`, async () => {
    __resetAgentRunsForTests();
    const fake = await listen();
    const frames = Array.from({ length: MAX_LOCAL_TOOL_REJECTIONS }, (_, i) => {
      const id = i + 1;
      if (kind === "native") return shellArgsFrame("ls", id);
      if (kind === "unknown") return unknownExecFrame(id);
      return mcpArgsFrame("ghost", `call-${String(id)}`, {});
    });
    let replies = 0;
    fake.onStream(
      serveFrames(frames, {
        onReply: () => {
          replies += 1;
        },
      }),
    );
    try {
      await assert.rejects(
        () => runAgentSession({ token: "tok", ir: ir({ sessionId: `sess-guard-${kind}` }), origin: fake.origin }),
        (error: unknown) => {
          assert.ok(error instanceof Error, "the guard rejects with a real error");
          assert.ok(error.message.includes(LOCAL_TOOL_LOOP_MESSAGE), "the guard reports the documented failure");
          assert.match(String((error as { nextStep?: string }).nextStep), /mcp_pi_echo/);
          return true;
        },
      );
      assert.ok(replies > 0, "misses below the budget are still answered in-band");
      assert.ok(replies < MAX_LOCAL_TOOL_REJECTIONS, "the failing miss is not answered: the run fails closed");
    } finally {
      fake.server.close();
      __resetAgentRunsForTests();
    }
  });
}

test("T-AGENT-SESSION: plan mode is acknowledged instead of answered with a fatal error", async () => {
  __resetAgentRunsForTests();
  const fake = await listen();
  const replies: Uint8Array[] = [];
  fake.onStream(
    serveFrames([planningArgsFrame(1)], {
      endAfter: 1,
      onReply: (body) => replies.push(body),
    }),
  );
  try {
    await runAgentSession({ token: "tok", ir: ir({ sessionId: "sess-plan" }), origin: fake.origin });
    assert.equal(replies.length, 1);
    const reply = execReplyOf(replies[0]!);
    assert.equal(reply.resultField, 36, "start_grind_planning_args is answered on its own result arm");
    assert.equal(
      firstInnerField(reply.resultBytes),
      1,
      "plan mode is acked on the success arm; the error arm made Cursor re-request it until the guard fired",
    );
    assert.equal(
      replyContains(replies[0]!, NATIVE_EXEC_REJECT),
      false,
      "an acked planning request must not carry a native-tool rejection",
    );
  } finally {
    fake.server.close();
    __resetAgentRunsForTests();
  }
});

test("T-AGENT-SESSION: an oversized tool result is truncated with an explicit marker", async () => {
  __resetAgentRunsForTests();
  const fake = await listen();
  let phase: "await-run" | "await-result" = "await-run";
  const resultFrames: Uint8Array[] = [];
  fake.onStream((stream) => {
    stream.respond({ ":status": 200, "content-type": "application/connect+proto" });
    const decoder = new ConnectFrameDecoder();
    stream.on("data", (chunk: Uint8Array) => {
      for (const frame of decoder.push(chunk)) {
        if (frame.endOfStream) continue;
        if (phase === "await-run") {
          phase = "await-result";
          writeProto(stream, mcpArgsFrame("echo", "call-big", { x: "1" }));
          return;
        }
        resultFrames.push(frame.body);
        writeProto(stream, textDelta("ok"));
        writeProto(stream, turnEnded());
        writeTrailer(stream);
      }
    });
  });
  try {
    await runAgentSession({ token: "tok", ir: ir({ sessionId: "sess-big" }), origin: fake.origin });
    const big = "x".repeat(MAX_MCP_RESULT_CHARS + 4096);
    await runAgentSession({
      token: "tok",
      ir: ir({
        sessionId: "sess-big",
        messages: [
          { role: "user", text: "ping" },
          { role: "assistant", toolCalls: [{ id: "call-big", name: "echo", arguments: { x: "1" } }] },
          { role: "tool", toolResult: { toolCallId: "call-big", toolName: "echo", result: big, isError: false } },
        ],
      }),
      origin: fake.origin,
    });
    assert.equal(resultFrames.length, 1, "the tool result is written back on the parked stream");
    const reply = resultFrames[0]!;
    assert.ok(
      replyContains(reply, "[pi-cursor-provider truncated this tool result.]"),
      "truncation is announced on the wire, never silent",
    );
    assert.ok(reply.byteLength < big.length, "the oversized result is actually cut down before it is sent");
  } finally {
    fake.server.close();
    __resetAgentRunsForTests();
  }
});

test("T-AGENT-SESSION: a real Pi tool call resets the miss budget", async () => {
  __resetAgentRunsForTests();
  const fake = await listen();
  const frames = [
    ...Array.from({ length: MAX_LOCAL_TOOL_REJECTIONS - 1 }, (_, i) => shellArgsFrame("ls", i + 1)),
    mcpArgsFrame("echo", "call-reset", { x: "1" }),
  ];
  fake.onStream(serveFrames(frames));
  try {
    const result = await runAgentSession({
      token: "tok",
      ir: ir({ sessionId: "sess-reset" }),
      origin: fake.origin,
    });
    const done = result.events.find((e) => e.type === "done");
    assert.equal(
      done && done.type === "done" ? done.stopReason : "",
      "toolUse",
      "7 rejects followed by a real MCP lift must survive to a normal toolUse yield",
    );
    assert.ok(result.events.some((e) => e.type === "tool_call" && e.name === "echo"));
  } finally {
    fake.server.close();
    __resetAgentRunsForTests();
  }
});
