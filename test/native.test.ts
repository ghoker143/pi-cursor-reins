// SPDX-License-Identifier: AGPL-3.0-or-later
/** Native exec translation: decode, pi-tool mapping, result encoding (PROTOCOL-AGENT §5.1). */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildAgentRequest } from "../src/agent/request.ts";
import { mcpContractText } from "../src/agent/policy.ts";
import {
  decodeNativeArgs,
  encodeNativeResultFromPi,
  nativeExecMode,
  translateNativeToPi,
  type NativeArgs,
} from "../src/agent/native.ts";
import type { DecodedExec } from "../src/proto/agent.ts";
import {
  WireType,
  encodeFields,
  expectBytes,
  expectString,
  expectVarint,
  forEachField,
  skipUnknown,
  writeBool,
  writeBytes,
  writeString,
  writeUint32,
} from "../src/proto/wire.ts";
import type { InferenceIR, IrTool } from "../src/session/ir.ts";

function execOf(execCase: DecodedExec["case"], field: number, payload: Uint8Array): DecodedExec {
  return { id: 7, execId: "e1", field, case: execCase, strings: {}, payload };
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): IrTool {
  return { name, description, jsonSchema: { type: "object", properties, required } };
}

const ctxShell = tool("ctx_shell", "Run a shell command", { command: { type: "string" }, timeout: { type: "number" } });
const readTool = tool("read", "Read a file", { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } });
const findTool = tool("fffind", "Find files by name pattern", { pattern: { type: "string" }, path: { type: "string" } });

test("T-NATIVE: mcpContractText lists only tools native translation cannot cover", () => {
  const dice = tool("roll_dice", "Roll dice and return the total.", {
    sides: { type: "number" },
    count: { type: "number" },
  }, ["sides", "count"]);
  const askTool = tool("ask_user_question", "Ask the user.\nSecond line is dropped.", {
    questions: { type: "array" },
    note: { type: "string" },
  }, ["questions"]);
  const all = [ctxShell, readTool, findTool, dice, askTool];
  const text = mcpContractText(all);
  // Core-capable tools are covered by native translation → excluded.
  assert.ok(!text.includes("ctx_shell"), "shell winner excluded");
  assert.ok(!text.includes("mcp_pi_read("), "read winner excluded");
  // Pi-only extras get a one-line signature each.
  assert.match(text, /mcp_pi_roll_dice\(sides, count\) — Roll dice and return the total\./);
  assert.match(text, /mcp_pi_ask_user_question\(questions, note\?\) — Ask the user\./);
  assert.match(text, /namespace "pi"/);
  // No extras → no contract at all.
  assert.equal(mcpContractText([ctxShell, readTool]), "");
});

test("T-NATIVE: mode env parsing", () => {
  assert.equal(nativeExecMode({}), "pi", "translation is the default");
  assert.equal(nativeExecMode({ CURSOR_PROVIDER_NATIVE_EXEC: "" }), "pi");
  assert.equal(nativeExecMode({ CURSOR_PROVIDER_NATIVE_EXEC: "inproc" }), "inproc");
  assert.equal(nativeExecMode({ CURSOR_PROVIDER_NATIVE_EXEC: "1" }), "pi");
  assert.equal(nativeExecMode({ CURSOR_PROVIDER_NATIVE_EXEC: "off" }), "pi", "legacy value is ignored; reject stays the fallback for untranslatable cases");
});

test("T-NATIVE: decodeNativeArgs decodes the translatable cases", () => {
  const shell = decodeNativeArgs(
    execOf(
      "shellArgs",
      2,
      encodeFields((w) => {
        writeString(w, 1, "echo hi");
        writeString(w, 2, "/tmp");
        writeUint32(w, 3, 5000);
        writeString(w, 15, "Run echo command");
      }),
    ),
  );
  assert.deepEqual(shell, { case: "shellArgs", command: "echo hi", workingDirectory: "/tmp", timeoutMs: 5000 });

  const read = decodeNativeArgs(
    execOf(
      "readArgs",
      7,
      encodeFields((w) => {
        writeString(w, 1, "a.txt");
        writeString(w, 2, "call-abc-0"); // tool_call_id, not offset/limit (live wire)
      }),
    ),
  );
  assert.deepEqual(read, { case: "readArgs", path: "a.txt" });

  const write = decodeNativeArgs(
    execOf(
      "writeArgs",
      3,
      encodeFields((w) => {
        writeString(w, 1, "b.txt");
        writeString(w, 2, "body");
      }),
    ),
  );
  assert.deepEqual(write, { case: "writeArgs", path: "b.txt", contents: "body" });

  const grep = decodeNativeArgs(
    execOf(
      "grepArgs",
      5,
      encodeFields((w) => {
        writeString(w, 1, "needle");
        writeBool(w, 2, true);
        writeString(w, 3, "*.ts");
        writeString(w, 4, "/src");
        writeString(w, 11, "files_with_matches");
      }),
    ),
  );
  assert.deepEqual(grep, {
    case: "grepArgs",
    pattern: "needle",
    glob: "*.ts",
    path: "/src",
    caseInsensitive: true,
    outputMode: "files_with_matches",
  });

  assert.equal(decodeNativeArgs(execOf("lsArgs", 8, new Uint8Array())), null);
  assert.equal(decodeNativeArgs(execOf("unknown", 99, new Uint8Array())), null);
});

test("T-NATIVE: shell translates to the capability-matched command tool, schema-adapted", () => {
  const args: NativeArgs = { case: "shellArgs", command: "echo hi", workingDirectory: "/tmp", timeoutMs: 5000 };
  const hit = translateNativeToPi(args, [ctxShell]);
  assert.ok(hit);
  assert.equal(hit.tool.name, "ctx_shell");
  // timeout is dropped (wire unit unverified); cwd dropped (no schema key).
  assert.deepEqual(hit.args, { command: "echo hi" });

  // A tool with no command-ish key can never serve a shell exec.
  assert.equal(translateNativeToPi(args, [tool("echo", "echo", { x: { type: "string" } })]), null);
  assert.equal(translateNativeToPi(args, []), null);
});

test("T-NATIVE: read/write/delete adapt to the tool's own schema keys", () => {
  const read = translateNativeToPi({ case: "readArgs", path: "a.txt" }, [readTool]);
  assert.deepEqual(read?.args, { path: "a.txt" });

  const writeContents = tool("write", "Write a file", { path: { type: "string" }, contents: { type: "string" } });
  const write = translateNativeToPi({ case: "writeArgs", path: "b.txt", contents: "body" }, [writeContents]);
  assert.deepEqual(write?.args, { path: "b.txt", contents: "body" });

  // A write tool whose schema declares neither content nor contents cannot serve.
  assert.equal(
    translateNativeToPi({ case: "writeArgs", path: "b.txt", contents: "body" }, [tool("edit", "Edit", { path: {} })]),
    null,
  );

  // Delete routes through the command tool (pi has no delete tool) with a
  // composite that captures the pre-delete size — a sizeless DeleteSuccess
  // stalls the backend (PROTOCOL-AGENT §5.1).
  const del = translateNativeToPi({ case: "deleteArgs", path: "it's.txt" }, [ctxShell]);
  assert.equal(del?.tool.name, "ctx_shell");
  const delCmd = String(del?.args.command);
  assert.ok(delCmd.includes("rm -- 'it'\\''s.txt'"));
  assert.ok(delCmd.includes("D0:%s"));
  // …and the encoder reports the parsed real size.
  const delReply = encodeNativeResultFromPi({ case: "deleteArgs", path: "/x.txt" }, "D0: 42\n", false);
  let sizeSeen = 0;
  forEachField(delReply.frames[0]!.resultBytes, (f, w, r) => {
    if (f !== 1) return skipUnknown(r, w, f);
    // DeleteResult.success (field 1) = DeleteSuccess {path=1, deleted_file=2, file_size=3}
    forEachField(expectBytes(r, w), (f2, w2, r2) => {
      if (f2 === 3) sizeSeen = expectVarint(r2, w2);
      else skipUnknown(r2, w2, f2);
    });
  });
  assert.equal(sizeSeen, 42);
});

test("T-NATIVE: grep maps content args; empty pattern + glob maps to a find-capable tool", () => {
  const grepTool = tool("ffgrep", "Search file contents", {
    pattern: { type: "string" },
    path: { type: "string" },
    glob: { type: "string" },
    caseSensitive: { type: "boolean" },
  });
  const grep = translateNativeToPi(
    { case: "grepArgs", pattern: "needle", glob: "*.ts", path: "/src", caseInsensitive: true, outputMode: "content" },
    [grepTool],
  );
  assert.equal(grep?.tool.name, "ffgrep");
  assert.deepEqual(grep?.args, { pattern: "needle", path: "/src", glob: "*.ts" }); // no case_insensitive key in schema → dropped

  const glob = translateNativeToPi(
    { case: "grepArgs", pattern: "", glob: "**/b.txt", path: "/src", caseInsensitive: false, outputMode: "files_with_matches" },
    [grepTool, findTool],
  );
  assert.equal(glob?.tool.name, "fffind");
  assert.deepEqual(glob?.args, { pattern: "**/b.txt", path: "/src" });
});

/** Pull (field → string) out of a nested message, for result-shape assertions. */
function stringFields(bytes: Uint8Array): Map<number, string> {
  const out = new Map<number, string>();
  forEachField(bytes, (field, wire, reader) => {
    if (wire === WireType.LengthDelimited) {
      try {
        out.set(field, expectString(reader, wire));
      } catch {
        skipUnknown(reader, wire, field);
      }
    } else skipUnknown(reader, wire, field);
  });
  return out;
}

test("T-NATIVE: pi result encodes to the native shell success/error arms", () => {
  const args: NativeArgs = { case: "shellArgs", command: "echo hi", workingDirectory: "/tmp", timeoutMs: 0 };
  const ok = encodeNativeResultFromPi(args, "hi\n", false);
  assert.equal(ok.closeStream, true, "every native result ends with stream_close (reference client behavior)");
  assert.equal(ok.frames.length, 1);
  assert.equal(ok.frames[0]?.resultField, 2);
  // shell_result.success (1) → stdout (5), exit_code (3)
  let stdout = "";
  let exit = -1;
  forEachField(ok.frames[0]?.resultBytes ?? new Uint8Array(), (field, wire, reader) => {
    if (field === 1) {
      forEachField(expectBytes(reader, wire), (f2, w2, r2) => {
        if (f2 === 5) stdout = expectString(r2, w2);
        else if (f2 === 3) exit = Number(expectVarint(r2, w2));
        else skipUnknown(r2, w2, f2);
      });
    } else skipUnknown(reader, wire, field);
  });
  assert.equal(stdout, "hi\n");
  assert.ok(exit <= 0, "exit_code 0 is omitted on the wire (proto3 default)");

  const bad = encodeNativeResultFromPi(args, "boom", true);  let arm = 0;
  forEachField(bad.frames[0]?.resultBytes ?? new Uint8Array(), (field, wire, reader) => {
    arm = field;
    skipUnknown(reader, wire, field);
  });
  assert.equal(arm, 2, "error maps to the failure arm");
});

test("T-NATIVE: shellStream emits stdout → exit frames and requires stream_close", () => {
  const args: NativeArgs = { case: "shellStreamArgs", command: "echo hi", workingDirectory: "/tmp", timeoutMs: 0 };
  const reply = encodeNativeResultFromPi(args, "hi\n", false);
  assert.equal(reply.closeStream, true);
  assert.equal(reply.frames.length, 2);
  assert.ok(reply.frames.every((f) => f.resultField === 14));
  // First frame: stdout event (oneof field 1); second: exit (oneof field 3).
  const kinds: number[] = [];
  for (const frame of reply.frames) {
    forEachField(frame.resultBytes, (field, wire, reader) => {
      kinds.push(field);
      skipUnknown(reader, wire, field);
    });
  }
  assert.deepEqual(kinds, [1, 3]);
});

test("T-NATIVE: grep content parses file:line:content, falls back to one raw match", () => {
  const args: NativeArgs = { case: "grepArgs", pattern: "needle", glob: "", path: "/src", caseInsensitive: false, outputMode: "content" };
  const parsed = encodeNativeResultFromPi(args, "a.ts:12:const needle = 1\nb.ts:3:needle();\n", false);
  assert.equal(parsed.frames[0]?.resultField, 5);
  const fallback = encodeNativeResultFromPi(args, "Found 2 matches in 2 files", false);
  assert.equal(fallback.frames.length, 1);
  const err = encodeNativeResultFromPi(args, "grep failed", true);
  let arm = 0;
  forEachField(err.frames[0]?.resultBytes ?? new Uint8Array(), (field, wire, reader) => {
    arm = field;
    skipUnknown(reader, wire, field);
  });
  assert.equal(arm, 2, "error maps to grep_result.error");
});

// ---------------------------------------------------------------------------
// Resume mcp_tools omission (PROTOCOL-AGENT §5.1, wire-verified 2026-09-29).
// ---------------------------------------------------------------------------

function irFor(tools: IrTool[]): InferenceIR {
  return {
    sessionId: "sess-native",
    systemPrompt: "sys",
    messages: [{ role: "user", text: "ping" }],
    tools,
    modelId: "composer-2.5",
    maxMode: false,
    contextWindow: 200_000,
  };
}

function resumeHandle(toolsetKey?: string): {
  conversationId: string;
  checkpoint: Uint8Array;
  fingerprint: string;
  blobs: { idHex: string; data: Uint8Array }[];
  toolsetKey?: string;
} {
  return {
    conversationId: "conv-1",
    checkpoint: encodeFields((w) => writeBytes(w, 1, new Uint8Array(32).fill(1))),
    fingerprint: "fp",
    blobs: [],
    ...(toolsetKey !== undefined ? { toolsetKey } : {}),
  };
}

/** Field numbers of the AgentRunRequest (nested in AgentClientMessage field 1). */
function requestFields(bytes: Uint8Array): number[] {
  const fields: number[] = [];
  forEachField(bytes, (field, wire, reader) => {
    if (field !== 1) {
      skipUnknown(reader, wire, field);
      return;
    }
    forEachField(expectBytes(reader, wire), (f, w, r) => {
      fields.push(f);
      skipUnknown(r, w, f);
    });
  });
  return fields;
}

test("T-NATIVE: resume omits mcp_tools when the tool set is unchanged, re-sends on change", () => {
  const tools = [tool("ctx_shell", "Run a shell command", { command: { type: "string" } })];
  const same = buildAgentRequest(irFor(tools), undefined, resumeHandle("ctx_shell"));
  assert.equal(requestFields(same.bytes).includes(4), false, "unchanged set: omit field 4");

  const changed = buildAgentRequest(irFor([...tools, readTool]), undefined, resumeHandle("ctx_shell"));
  assert.equal(requestFields(changed.bytes).includes(4), true, "changed set: re-send field 4");

  const legacy = buildAgentRequest(irFor(tools), undefined, resumeHandle());
  assert.equal(requestFields(legacy.bytes).includes(4), true, "handle without toolsetKey: re-send");

  const fresh = buildAgentRequest(irFor(tools));
  assert.equal(requestFields(fresh.bytes).includes(4), true, "fresh conversation always sends");

  const prev = process.env.CURSOR_PROVIDER_RESEND_MCP_ON_RESUME;
  process.env.CURSOR_PROVIDER_RESEND_MCP_ON_RESUME = "1";
  try {
    const forced = buildAgentRequest(irFor(tools), undefined, resumeHandle("ctx_shell"));
    assert.equal(requestFields(forced.bytes).includes(4), true, "env escape hatch re-sends");
  } finally {
    if (prev === undefined) delete process.env.CURSOR_PROVIDER_RESEND_MCP_ON_RESUME;
    else process.env.CURSOR_PROVIDER_RESEND_MCP_ON_RESUME = prev;
  }
});
