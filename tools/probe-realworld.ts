// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Realistic multi-step task probe: one conversation, one compound instruction,
 * the model orchestrates native tools across many rounds. The probe plays Pi.
 *
 *   node --experimental-strip-types tools/probe-realworld.ts
 *
 * Pass = the final filesystem state matches: package.json + index.js exist,
 * index.js prints "app-ok", README.md exists and mentions the app.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.CURSOR_PROVIDER_DEBUG = "1";

const { runAgentSession } = await import("../src/agent/index.ts");
const { fakePiExecute, loadAccess, TOOLS } = await import("./lib/fake-pi.ts");
import type { IrMessage } from "../src/session/ir.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-realworld-"));
const token = loadAccess();
const sessionId = crypto.randomUUID();
const modelId = process.env.PROBE_MODEL ?? "grok-4.7";

const messages: IrMessage[] = [
  {
    role: "user",
    text: [
      `Build a tiny Node project in ${dir}:`,
      "1. Write package.json with name \"probe-app\" and a start script running index.js.",
      "2. Write index.js that prints exactly: app-ok",
      "3. Run it and confirm it prints app-ok.",
      "4. Write README.md briefly describing the app.",
      "5. Finally list the directory contents to confirm everything is in place.",
      "Use your tools for every step. Report what you did at the end.",
    ].join("\n"),
  },
];

const calls: string[] = [];
let text = "";
for (let round = 0; round < 15; round += 1) {
  const result = await runAgentSession({
    token,
    ir: { sessionId, systemPrompt: "", messages, tools: TOOLS, modelId, maxMode: false, contextWindow: 200_000 },
    hooks: {},
  });
  let batch: { id: string; name: string; arguments?: Record<string, unknown> }[] = [];
  for (const e of result.events) {
    if (e.type === "text") text += e.delta;
    if (e.type === "tool_call") batch.push({ id: e.id, name: e.name, arguments: e.arguments ?? {} });
  }
  if (batch.length === 0) break;
  for (const call of batch) {
    calls.push(`${call.name} ${JSON.stringify(call.arguments).slice(0, 60)}`);
    const res = fakePiExecute(call.name, call.arguments ?? {});
    messages.push({ role: "assistant", toolCalls: [{ id: call.id, name: call.name, arguments: call.arguments ?? {} }] });
    messages.push({ role: "tool", toolResult: { toolCallId: call.id, toolName: call.name, result: res.text, isError: res.isError } });
  }
}

const pkg = has("package.json") ? JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string } : {};
const run = has("index.js") ? spawnSync("node", [path.join(dir, "index.js")], { encoding: "utf8" }) : null;
const checks: Record<string, boolean> = {
  packageJson: pkg.name === "probe-app",
  indexRuns: run?.stdout.trim() === "app-ok",
  readme: has("README.md") && fs.readFileSync(path.join(dir, "README.md"), "utf8").length > 20,
  usedTools: calls.length >= 3,
};
function has(f: string): boolean {
  return fs.existsSync(path.join(dir, f));
}

const ok = Object.values(checks).every(Boolean);
console.log(JSON.stringify({ ok, model: modelId, checks, calls, text: text.slice(0, 300) }, null, 1));
process.exitCode = ok ? 0 : 1;
