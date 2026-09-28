// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { EXEC_CASES, EXEC_FIELD, encodeKvGetResult, encodeMcpSuccess, encodeRunRequest, encodeUserMessage } from "../src/proto/agent.ts";
import { decideExec, localToolPolicyText, rankAlternatives, rankedTools, rejectReason, stripCursorMcpToolName, cursorMcpToolName, unknownExecThrowMessage } from "../src/agent/policy.ts";
import { BlobStore } from "../src/agent/blob-store.ts";
import { buildRootPromptMessages, splitCurrentUser, systemPromptRootMessage } from "../src/agent/root-prompt.ts";
import { buildAgentRequest } from "../src/agent/request.ts";
import { MAX_BLOB_STORE_BYTES } from "../src/constants.ts";
import { NATIVE_EXEC_REJECT } from "../src/errors.ts";
import type { InferenceIR, IrTool } from "../src/session/ir.ts";
import type { DecodedExec, ExecCase } from "../src/proto/agent.ts";
import { expectBytes, expectVarint, forEachField, skipUnknown } from "../src/proto/wire.ts";

function ir(over: Partial<InferenceIR> = {}): InferenceIR {
  return {
    sessionId: "s",
    systemPrompt: "sys",
    messages: [{ role: "user", text: "hello" }],
    tools: [{ name: "bash", description: "shell", jsonSchema: { type: "object" } }],
    modelId: "composer-2.5",
    maxMode: false,
    contextWindow: 200_000,
    ...over,
  };
}

function exec(execCase: ExecCase | "unknown", over: Partial<DecodedExec> = {}): DecodedExec {
  return {
    id: 1,
    execId: "e1",
    field: execCase === "unknown" ? 99 : EXEC_FIELD[execCase],
    case: execCase,
    strings: { command: "ls", path: "/tmp/x", workingDirectory: "/tmp", url: "https://example.com", uri: "file://x" },
    ...over,
  };
}

test("T-AGENT: every schema exec case has a decision", () => {
  const classified = new Set<string>();
  for (const execCase of EXEC_CASES) {
    const decision = decideExec(exec(execCase), ir().tools);
    classified.add(execCase);
    if (execCase === "mcpArgs") assert.equal(decision.action, "mcp");
    else if (execCase === "requestContextArgs") assert.equal(decision.action, "context");
    else if (execCase === "setupVmEnvironmentArgs") assert.equal(decision.action, "throw");
    else assert.equal(decision.action, "reject");
  }
  assert.deepEqual([...classified].sort(), [...EXEC_CASES].sort());
  assert.equal(decideExec(exec("unknown"), ir().tools).action, "throw");
});

test("T-AGENT: EXEC_FIELD covers EXEC_CASES 1:1", () => {
  assert.equal(Object.keys(EXEC_FIELD).length, EXEC_CASES.length);
  const fields = new Set(Object.values(EXEC_FIELD));
  assert.equal(fields.size, EXEC_CASES.length);
});

test("T-AGENT: native reject reason names Pi MCP tools and forbids local work", () => {
  const reason = rejectReason("shellArgs", ir().tools);
  assert.match(reason, new RegExp(NATIVE_EXEC_REJECT));
  assert.match(reason, /mcp_pi_bash/);
  assert.match(reason, /No operation was performed/);
});

test("T-AGENT: rejection guidance ranks the capability-matched tool and embeds the exact command", () => {
  // lean-ctx style catalog: no classic "bash" tool, ctx_shell carries commands.
  const tools: IrTool[] = [
    { name: "read", description: "r", jsonSchema: { type: "object", properties: { path: { type: "string" } } } },
    { name: "ctx_shell", description: "shell", jsonSchema: { type: "object", properties: { command: { type: "string" } } } },
    { name: "edit", description: "e", jsonSchema: { type: "object", properties: { path: { type: "string" } } } },
  ];
  const shell = rejectReason("shellArgs", tools, "vainfo --display drm");
  assert.match(shell, /To run that command from Pi, call the MCP tool `mcp_pi_ctx_shell`/);
  assert.match(shell, /\{"command": "vainfo --display drm"\}/);
  const read = rejectReason("readArgs", tools, "/etc/fstab");
  assert.match(read, /`mcp_pi_read`/);
  assert.match(read, /\{"path": "\/etc\/fstab"\}/);
  const escalated = rejectReason("shellArgs", tools, "vainfo --display drm", true);
  assert.match(escalated, /STOP calling Cursor native tools/);
  assert.match(escalated, /namespace "pi"/);
  assert.match(escalated, /mcp_pi_ctx_shell/);
  const none = rejectReason("shellArgs", []);
  assert.match(none, /No Pi MCP tools are exposed/);
});

test("T-AGENT: a rejection without a concrete value still names the parameter", () => {
  const tools: IrTool[] = [
    {
      name: "ffgrep",
      description: "search",
      jsonSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
    },
  ];
  // A native frame that carries no command/path must not degrade to a bare tool name:
  // the model would call it with no arguments and pi's validator would reject it.
  assert.match(rejectReason("grepArgs", tools, ""), /\{"pattern": "…"\}/);
  assert.match(rejectReason("grepArgs", tools, "TODO"), /\{"pattern": "TODO"\}/);
});

test("T-AGENT: root-prompt policy leads with the intent map", () => {
  const tools: IrTool[] = [
    { name: "ctx_shell", description: "shell", jsonSchema: { type: "object", properties: { command: { type: "string" } } } },
    { name: "ctx_read", description: "r", jsonSchema: { type: "object", properties: { path: { type: "string" } } } },
    { name: "ffgrep", description: "g", jsonSchema: { type: "object", properties: { pattern: { type: "string" } } } },
    { name: "edit", description: "e", jsonSchema: { type: "object", properties: { path: { type: "string" } } } },
  ];
  const text = localToolPolicyText(tools);
  const cmdAt = text.indexOf("Run commands with mcp_pi_ctx_shell");
  const listAt = text.indexOf("Registered Pi MCP tools");
  assert.ok(cmdAt > -1, "intent map present");
  assert.ok(listAt > cmdAt, "full tool list comes after the intent map");
  assert.match(text, /Search with mcp_pi_ffgrep/);
  assert.match(text, /do not call or retry them/);
  assert.match(text, /Cursor dynamic tools in the MCP namespace "pi"/);
  assert.match(text, /CallDynamicTool/);
  assert.match(text, /is NOT a reason to fall back/, "the missing-listing trap is called out explicitly");
  // The dynamic-tool listing can omit schemas, so the policy text carries the argument
  // names itself; a bare call would be rejected by pi's own argument validation.
  assert.match(text, /mcp_pi_ctx_shell\(command\)/);
  assert.match(text, /mcp_pi_ffgrep\(pattern\)/);
  assert.match(localToolPolicyText([]), /No Pi MCP tools are exposed/);
});

test("T-AGENT: tool_not_found alternatives rank by shared capability word", () => {
  const available = ["read", "edit", "write", "ctx_shell", "ctx_execute", "ffgrep"];
  const ranked = rankAlternatives("sudo_exec", available);
  assert.equal(ranked[0], "ctx_execute");
  const shellRank = rankAlternatives("ctx_shell_typo", available);
  assert.equal(shellRank[0], "ctx_shell");
  const unknown = rankAlternatives("completely_unrelated", available);
  assert.equal(unknown[0], "read", "no signal → registration order");
});

test("T-AGENT: capability ranking falls back to zero-maintenance signals (schema + description)", () => {
  // Naming that matches NO fragment word — schema and description still rank it.
  const alien = {
    name: "zqx",
    description: "Run commands in a sandbox",
    jsonSchema: { type: "object", properties: { command: { type: "string" } } },
  };
  const descOnly = { name: "zqy", description: "execute shell commands", jsonSchema: { type: "object" } };
  const plain = { name: "read", description: "read files", jsonSchema: { type: "object", properties: { path: { type: "string" } } } };
  const ranked = rankedTools("shellArgs", [plain, descOnly, alien]);
  assert.equal(ranked[0]?.name, "zqx", "schema command property wins without any name match");
  assert.equal(ranked[1]?.name, "zqy", "description keyword is the next signal");
  // Name fragment still beats both auto signals.
  const named = { name: "ctx_shell", description: "", jsonSchema: { type: "object" } };
  assert.equal(rankedTools("shellArgs", [alien, named])[0]?.name, "ctx_shell");
});

test("T-AGENT: unknown exec throw redirects to the ranked command tool", () => {
  const tools: IrTool[] = [
    { name: "read", description: "r", jsonSchema: { type: "object", properties: { path: { type: "string" } } } },
    { name: "ctx_shell", description: "s", jsonSchema: { type: "object", properties: { command: { type: "string" } } } },
  ];
  const message = unknownExecThrowMessage("37", tools);
  assert.match(message, /no handler for exec case "37"/);
  assert.match(message, /call the MCP tool `mcp_pi_ctx_shell`/);
  assert.equal(unknownExecThrowMessage("37", []).includes("call the MCP tool"), false);
});

test("T-AGENT: mcp_pi prefix round-trips", () => {
  assert.equal(cursorMcpToolName("bash"), "mcp_pi_bash");
  assert.equal(stripCursorMcpToolName("mcp_pi_bash"), "bash");
  assert.equal(stripCursorMcpToolName("bash"), "bash");
});

test("T-AGENT: blob store is memory-only and fail-closed at 64MiB", () => {
  const store = new BlobStore();
  const id = store.put(new TextEncoder().encode("hello"));
  assert.equal(id.byteLength, 32);
  assert.deepEqual(store.get(id), new TextEncoder().encode("hello"));
  assert.equal(store.put(new TextEncoder().encode("hello")).length, 32);
  assert.equal(MAX_BLOB_STORE_BYTES, 64 * 1024 * 1024);
});

test("T-AGENT: root prompt carries system as user rules and mcp_pi tool names", () => {
  const { history, userText } = splitCurrentUser(
    ir({
      messages: [
        { role: "user", text: "hi" },
        {
          role: "assistant",
          text: "ok",
          toolCalls: [{ id: "t1", name: "bash", arguments: { command: "pwd" } }],
        },
        { role: "tool", toolResult: { toolCallId: "t1", toolName: "bash", result: "/tmp", isError: false } },
        { role: "user", text: "again" },
      ],
    }),
  );
  assert.equal(userText, "again");
  const prompt = buildRootPromptMessages(ir({ messages: history, systemPrompt: "be terse" }), history);
  assert.equal(prompt[0]?.role, "user");
  const first = prompt[0];
  const textPart = first && first.role === "user" ? first.content.find((p) => p.type === "text") : undefined;
  const rules = textPart && textPart.type === "text" ? textPart.text : "";
  assert.match(rules ?? "", /<rules>/);
  assert.match(rules ?? "", /be terse/);
  const assistant = prompt.find((m) => m.role === "assistant");
  assert.ok(assistant && assistant.role === "assistant");
  const call = assistant.content.find((p) => p.type === "tool-call");
  assert.equal(call && call.type === "tool-call" ? call.toolName : "", "mcp_pi_bash");
});

test("T-AGENT: systemPromptRootMessage is never role=system", () => {
  const msg = systemPromptRootMessage("x");
  assert.equal(msg.role, "user");
});

/** requested_model.parameters: run_request field 9, repeated field 3 = {id=1, value=2}. */
function requestedModelParams(body: Uint8Array): { id: string; value: string }[] {
  const out: { id: string; value: string }[] = [];
  forEachField(body, (field, wire, reader) => {
    if (field !== 1) {
      skipUnknown(reader, wire, field);
      return;
    }
    forEachField(expectBytes(reader, wire), (f, w, r) => {
      if (f !== 9) {
        skipUnknown(r, w, f);
        return;
      }
      forEachField(expectBytes(r, w), (pf, pw, pr) => {
        if (pf !== 3) {
          skipUnknown(pr, pw, pf);
          return;
        }
        const param = { id: "", value: "" };
        forEachField(expectBytes(pr, pw), (k, kw, kr) => {
          if (k === 1) param.id = new TextDecoder().decode(expectBytes(kr, kw));
          else if (k === 2) param.value = new TextDecoder().decode(expectBytes(kr, kw));
          else skipUnknown(kr, kw, k);
        });
        out.push(param);
      });
    });
  });
  return out;
}

test("T-AGENT: thinking effort rides requested_model.parameters, not the model id", () => {
  const req = buildAgentRequest(
    ir({ contextParam: "256k", effortParams: [{ id: "reasoning_effort", value: "high" }] }),
  );
  assert.deepEqual(requestedModelParams(req.bytes), [
    { id: "context", value: "256k" },
    { id: "reasoning_effort", value: "high" },
  ]);
  assert.deepEqual(requestedModelParams(buildAgentRequest(ir()).bytes), [], "no context and no level sends no parameters");
});

test("T-AGENT: run_request encodes conversation_id and mcp tools", () => {
  const req = buildAgentRequest(ir());
  assert.ok(req.bytes.byteLength > 0);
  assert.equal(req.tools[0]?.name, "bash");
  assert.match(req.workspaceUri, /^file:/);
  assert.notEqual(req.conversationId, "s");
  assert.match(req.conversationId, /^[0-9a-f-]{36}$/i);
  assert.notEqual(buildAgentRequest(ir()).conversationId, req.conversationId);
});

test("T-AGENT: user images encode as SelectedContext and inline-image gate", () => {
  const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47);
  const user = encodeUserMessage({
    text: "look",
    messageId: "m1",
    selectedContextBlob: Uint8Array.of(1),
    images: [{ uuid: "u1", path: "pi-image-u1.png", mimeType: "image/png", data: png }],
  });
  let selected: Uint8Array | undefined;
  forEachField(user, (field, wire, reader) => {
    if (field === 3) selected = new Uint8Array(expectBytes(reader, wire));
    else skipUnknown(reader, wire, field);
  });
  assert.ok(selected);
  let image: Uint8Array | undefined;
  forEachField(selected, (field, wire, reader) => {
    if (field === 1) image = new Uint8Array(expectBytes(reader, wire));
    else skipUnknown(reader, wire, field);
  });
  assert.ok(image);
  let mime = "";
  let data: Uint8Array | undefined;
  forEachField(image, (field, wire, reader) => {
    if (field === 7) mime = new TextDecoder().decode(expectBytes(reader, wire));
    else if (field === 8) data = new Uint8Array(expectBytes(reader, wire));
    else skipUnknown(reader, wire, field);
  });
  assert.equal(mime, "image/png");
  assert.deepEqual([...data!], [0x89, 0x50, 0x4e, 0x47]);

  const run = encodeRunRequest({
    conversationState: Uint8Array.of(1),
    userMessage: user,
    requestedModel: Uint8Array.of(1),
    mcpTools: Uint8Array.of(1),
    conversationId: "c1",
  });
  let inner: Uint8Array | undefined;
  forEachField(run, (field, wire, reader) => {
    if (field === 1) inner = new Uint8Array(expectBytes(reader, wire));
    else skipUnknown(reader, wire, field);
  });
  assert.ok(inner);
  let inline = false;
  forEachField(inner, (field, wire, reader) => {
    if (field === 19) {
      inline = expectVarint(reader, wire) === 1;
    } else skipUnknown(reader, wire, field);
  });
  assert.equal(inline, true);
});

test("T-AGENT: MCP success can carry image content items", () => {
  const frame = encodeMcpSuccess("note", false, [{ data: Uint8Array.of(1, 2), mimeType: "image/png" }]);
  let result: Uint8Array | undefined;
  forEachField(frame, (field, wire, reader) => {
    if (field === 1) result = new Uint8Array(expectBytes(reader, wire));
    else skipUnknown(reader, wire, field);
  });
  assert.ok(result);
  const items: number[] = [];
  forEachField(result, (field, wire, reader) => {
    if (field === 1) {
      const item = new Uint8Array(expectBytes(reader, wire));
      forEachField(item, (f, w, r) => {
        items.push(f);
        skipUnknown(r, w, f);
      });
    } else skipUnknown(reader, wire, field);
  });
  assert.deepEqual(items, [1, 2]);
});

test("T-AGENT: rebuild root prompt keeps historical user images", () => {
  const { history } = splitCurrentUser(
    ir({
      messages: [
        {
          role: "user",
          text: "see",
          images: [{ data: "aaa", mimeType: "image/png" }],
        },
        { role: "assistant", text: "ok" },
        { role: "user", text: "now" },
      ],
    }),
  );
  const prompt = buildRootPromptMessages(ir({ messages: history, systemPrompt: "x" }), history);
  const user = prompt.find((m) => m.role === "user" && m.content.some((p) => p.type === "image"));
  assert.ok(user && user.role === "user");
  const image = user.content.find((p) => p.type === "image");
  assert.equal(image && image.type === "image" ? image.image : "", "data:image/png;base64,aaa");
});

test("T-AGENT: kv get result echoes id 0", () => {
  const frame = encodeKvGetResult(0, Uint8Array.of(7));
  let kv: Uint8Array | undefined;
  forEachField(frame, (field, wire, reader) => {
    if (field === 3) kv = expectBytes(reader, wire);
    else skipUnknown(reader, wire, field);
  });
  assert.ok(kv);
  let id: number | undefined;
  forEachField(kv, (field, wire, reader) => {
    if (field === 1) id = expectVarint(reader, wire);
    else skipUnknown(reader, wire, field);
  });
  assert.equal(id, 0);
});
