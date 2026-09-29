// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Native exec probe against the live Cursor AgentService backend.
 *
 *   node --experimental-strip-types tools/probe-native.ts <scenario> [--inproc]
 *
 * Default mode (CURSOR_PROVIDER_NATIVE_EXEC=pi): the provider translates the
 * model's native tool call into a Pi tool_call; this probe plays Pi — it
 * executes the translated call locally and feeds the result back through the
 * continuation channel, exactly like a real pi session would.
 *
 * --inproc (CURSOR_PROVIDER_NATIVE_EXEC=inproc): the provider executes
 * in-process (wire-shape validation only).
 *
 * Scenarios: shell | read | write | delete | grep | ls
 *
 * Asserts the model's final text contains the fixture content (i.e. the native
 * result was accepted), and checks the filesystem side effect for write/delete.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fakePiExecute, loadAccess, TOOLS } from "./lib/fake-pi.ts";

const inproc = process.argv.includes("--inproc");
if (inproc) process.env.CURSOR_PROVIDER_NATIVE_EXEC = "inproc"; // default is already "pi"

const { runAgentSession } = await import("../src/agent/index.ts");
const { debugLog } = await import("../src/transport/debug.ts");

interface Scenario {
  dir: string;
  prompt: (dir: string) => string;
  expect?: RegExp;
  verify?: (dir: string) => boolean;
}

const scenarioName = process.argv[2] ?? "shell";
const SCENARIOS: Record<string, Scenario> = {
  shell: {
    dir: "",
    prompt: () =>
      'Run the shell command `echo native-probe-42` using your native Shell tool (not any MCP/dynamic tool), then tell me exactly what the command printed.',
    expect: /native-probe-42/,
  },
  read: {
    dir: "read",
    prompt: (dir) =>
      `Read the file ${dir}/probe-read.txt using your native Read tool (not any MCP/dynamic tool), then quote its contents back to me exactly.`,
    expect: /probe-read-1234/,
  },
  write: {
    dir: "write",
    prompt: (dir) =>
      `The file ${dir}/probe-write.txt already exists. Overwrite it so its content is exactly "written-by-native-probe", using your native Write/ApplyEdit tool (not any MCP/dynamic tool, not the shell). Then confirm.`,
    verify: (dir) => {
      try {
        return fs.readFileSync(path.join(dir, "probe-write.txt"), "utf8").includes("written-by-native-probe");
      } catch {
        return false;
      }
    },
  },
  delete: {
    dir: "delete",
    prompt: (dir) =>
      `Delete the file ${dir}/probe-delete.txt using your native Delete tool (not the shell). Then confirm the deletion.`,
    verify: (dir) => !fs.existsSync(path.join(dir, "probe-delete.txt")),
  },
  grep: {
    dir: "grep",
    prompt: (dir) =>
      `Search for the string "probe-needle" in the directory ${dir} using your native Grep tool (not any MCP/dynamic tool), and tell me which file contains it.`,
    expect: /a\.txt/,
  },
  ls: {
    dir: "ls",
    prompt: (dir) =>
      `List the files in the directory ${dir} using your native LS/directory-listing tool (not Glob, not shell, not any MCP/dynamic tool). Tell me the file names you see.`,
    expect: /ls-marker-alpha/,
  },
};

const scenario = SCENARIOS[scenarioName];
if (!scenario) {
  console.error(`unknown scenario ${scenarioName}; have: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(2);
}

const dir = scenario.dir ? fs.mkdtempSync(path.join(os.tmpdir(), `probe-native-${scenario.dir}-`)) : "";
if (scenarioName === "read") fs.writeFileSync(path.join(dir, "probe-read.txt"), "probe-read-1234\nsecond line\n");
if (scenarioName === "write") fs.writeFileSync(path.join(dir, "probe-write.txt"), "placeholder\n");
if (scenarioName === "delete") fs.writeFileSync(path.join(dir, "probe-delete.txt"), "delete me\n");
if (scenarioName === "grep") fs.writeFileSync(path.join(dir, "a.txt"), "xx probe-needle yy\n");
if (scenarioName === "ls") {
  fs.writeFileSync(path.join(dir, "ls-marker-alpha.txt"), "a\n");
  fs.writeFileSync(path.join(dir, "ls-marker-beta.txt"), "b\n");
}

const token = loadAccess();
const sessionId = crypto.randomUUID();
const messages: { role: string; text?: string; toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[]; toolResult?: { toolCallId: string; toolName: string; result: string; isError: boolean } }[] = [
  { role: "user", text: scenario.prompt(dir) },
];

const nativeCalls: string[] = [];
const piCalls: string[] = [];
let text = "";

// Drive loop: the probe plays Pi — execute each lifted tool_call and feed the
// result back, until the model answers with text. Inproc mode executes inside
// the provider, so the first response is already final.
for (let round = 0; round < 10; round += 1) {
  const result = await runAgentSession({
    token,
    ir: {
      sessionId,
      systemPrompt: "",
      messages: messages as never,
      tools: TOOLS,
      modelId: process.env.PROBE_MODEL ?? "grok-4.7",
      maxMode: false,
      contextWindow: 200_000,
    },
    hooks: {},
  });
  const call = result.events.find((e) => e.type === "tool_call");
  text = "";
  for (const e of result.events) if (e.type === "text") text += e.delta;
  if (!call || call.type !== "tool_call") break;
  if (call.name.startsWith("native:")) {
    nativeCalls.push(`${call.name} ${JSON.stringify(call.arguments)}`);
    break; // inproc mode: provider executed already
  }
  piCalls.push(`${call.name} ${JSON.stringify(call.arguments).slice(0, 120)}`);
  const res = fakePiExecute(call.name, call.arguments ?? {});
  messages.push({ role: "assistant", toolCalls: [{ id: call.id, name: call.name, arguments: call.arguments as Record<string, unknown> }] });
  messages.push({ role: "tool", toolResult: { toolCallId: call.id, toolName: call.name, result: res.text, isError: res.isError } });
}

let ok = true;
let reason = "";
if (scenario.expect && !scenario.expect.test(text)) {
  ok = false;
  reason = `expected ${String(scenario.expect)} in model text`;
}
if (scenario.verify && !scenario.verify(dir)) {
  ok = false;
  reason = "filesystem side effect missing";
}

debugLog({ event: "probe-native-done", scenario: scenarioName, mode: inproc ? "inproc" : "pi", ok, reason, piCalls, nativeCalls });
console.log(
  JSON.stringify(
    {
      ok,
      scenario: scenarioName,
      mode: inproc ? "inproc" : "pi",
      consumed: scenario.expect ? scenario.expect.test(text) : undefined,
      piCalls,
      nativeCalls,
      reason: reason === "" ? undefined : reason,
      text: text.slice(0, 600),
    },
    null,
    1,
  ),
);
process.exitCode = ok ? 0 : 1;
