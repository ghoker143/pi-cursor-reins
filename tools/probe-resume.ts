// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Resume + mcp_tools probe. Three scenarios against the live backend:
 *
 *   node --experimental-strip-types tools/probe-resume.ts baseline|omit|change
 *
 * - baseline: run 2 re-sends the same mcp_tools (CURSOR_PROVIDER_RESEND_MCP_ON_RESUME=1).
 * - omit:     run 2 uses the default — mcp_tools omitted when the tool set matches the handle.
 * - change:   run 2 sends a CHANGED tool set (auto re-send on toolsetKey mismatch).
 *
 * Pass = the model still manages to call get_magic_number in run 2.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runAgentSession } from "../src/agent/index.ts";
import type { IrEvent, IrMessage, IrTool } from "../src/session/ir.ts";

function loadAccess(): string {
  const env = process.env.PI_CURSOR_TOKEN;
  if (env && env !== "") return env;
  for (const path of [
    join(homedir(), ".pi/agent/auth.json"),
    join(homedir(), ".config/pi/agent/auth.json"),
  ]) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { cursor?: { access?: string } };
      if (raw.cursor?.access) return raw.cursor.access;
    } catch {
      /* next */
    }
  }
  throw new Error("no cursor credential");
}

const scenario = process.argv[2] ?? "baseline";
if (!["baseline", "omit", "change"].includes(scenario)) {
  console.error("usage: probe-resume.ts baseline|omit|change");
  process.exit(2);
}

const MAGIC: IrTool = {
  name: "get_magic_number",
  description: "Returns the magic number. Takes no arguments.",
  jsonSchema: { type: "object", properties: {} },
};
const EXTRA: IrTool = {
  name: "get_weather",
  description: "Returns the weather. Takes no arguments.",
  jsonSchema: { type: "object", properties: {} },
};

const token = loadAccess();
const sessionId = crypto.randomUUID();
const modelId = process.env.PROBE_MODEL ?? "grok-4.7";
const systemPrompt =
  'You have MCP tools in namespace "pi". To call one, use CallDynamicTool with namespace "pi" and the tool id (e.g. mcp_pi_get_magic_number). Never claim tools are unavailable.';

interface RunOutcome {
  events: IrEvent[];
  toolCall?: { id: string; name: string; arguments: Record<string, unknown> };
  text: string;
}

async function drive(messages: IrMessage[], tools: IrTool[]): Promise<RunOutcome> {
  const result = await runAgentSession({
    token,
    ir: { sessionId, systemPrompt, messages, tools, modelId, maxMode: false, contextWindow: 200_000 },
    hooks: {},
  });
  const out: RunOutcome = { events: result.events, text: "" };
  for (const e of result.events) {
    if (e.type === "text") out.text += e.delta;
    if (e.type === "tool_call" && !out.toolCall) {
      out.toolCall = { id: e.id, name: e.name, arguments: e.arguments ?? {} };
    }
  }
  return out;
}

const messages: IrMessage[] = [
  { role: "user", text: "Call the MCP tool get_magic_number (namespace pi) with CallDynamicTool, then report the number it returns." },
];

// Run 1: expect the tool call, answer it, let the model report.
const r1 = await drive(messages, [MAGIC]);
if (!r1.toolCall || r1.toolCall.name !== "get_magic_number") {
  console.log(JSON.stringify({ ok: false, stage: "run1-call", text: r1.text.slice(0, 300) }, null, 1));
  process.exit(1);
}
messages.push({ role: "assistant", toolCalls: [r1.toolCall] });
messages.push({
  role: "tool",
  toolResult: { toolCallId: r1.toolCall.id, toolName: r1.toolCall.name, result: "The magic number is 4242.", isError: false },
});
const r1b = await drive(messages, [MAGIC]);
messages.push({ role: "assistant", text: r1b.text });

// Run 2 (new user turn, resume from checkpoint): tool availability check.
if (scenario === "baseline") process.env.CURSOR_PROVIDER_RESEND_MCP_ON_RESUME = "1";
const tools2 = scenario === "change" ? [MAGIC, EXTRA] : [MAGIC];
messages.push({
  role: "user",
  text:
    scenario === "change"
      ? "Call the MCP tool get_weather with CallDynamicTool (namespace pi) and report what it returns."
      : "Call get_magic_number once more with CallDynamicTool (namespace pi) and report the number.",
});
const r2 = await drive(messages, tools2);
const want = scenario === "change" ? "get_weather" : "get_magic_number";
const called = r2.toolCall?.name === want;
console.log(
  JSON.stringify(
    {
      ok: called,
      scenario,
      run1Report: r1b.text.slice(0, 120),
      run2: called ? "tool-called" : r2.text.slice(0, 300),
    },
    null,
    1,
  ),
);
process.exitCode = called ? 0 : 1;
