// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live only-mode probe: the advertised catalog is just `codemode` (pi 0.99
 * `codemode.mode=only`). Native Shell/Read/Write/Grep/Delete must lift to a
 * `{ code }` script — never an undeclared `bash`/`read`/`write` tool_call.
 *
 *   PROBE_MODEL=composer-2.5 node --experimental-strip-types tools/probe-only-mode.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.CURSOR_PROVIDER_DEBUG = "1";

const { runAgentSession } = await import("../src/agent/index.ts");
const { fakePiExecute, loadAccess, ONLY_MODE_TOOLS } = await import("./lib/fake-pi.ts");
import type { IrMessage } from "../src/session/ir.ts";

const DEBUG_LOG = path.resolve(".cursor-provider-debug.log");
const DERAIL =
  /MCP 服务器|服务器.{0,8}不存在|工具通道|工具不可用|无法调用工具|没有可用的工具|don't have access to (any )?tools|no tools (are )?available|cannot use (any )?tools|tools? (are|is) (currently )?(unavailable|not available)/i;

function badEventsSince(byteOffset: number): { count: number; offset: number; samples: string[] } {
  let size = 0;
  try {
    size = fs.statSync(DEBUG_LOG).size;
  } catch {
    return { count: 0, offset: 0, samples: [] };
  }
  if (size <= byteOffset) return { count: 0, offset: byteOffset, samples: [] };
  const fd = fs.openSync(DEBUG_LOG, "r");
  const buf = Buffer.alloc(size - byteOffset);
  fs.readSync(fd, buf, 0, buf.length, byteOffset);
  fs.closeSync(fd);
  const lines = buf.toString("utf8").split("\n").filter((l) => l.includes("agent-local-miss") || l.includes("agent-native-decode-error"));
  return { count: lines.length, offset: size, samples: lines.slice(0, 3).map((l) => l.slice(0, 200)) };
}

const read = (p: string) => fs.readFileSync(p, "utf8");
const has = (p: string) => fs.existsSync(p);

interface Turn {
  prompt: (dir: string) => string;
  check: (dir: string, text: string) => string | null;
}

const TURNS: Turn[] = [
  {
    prompt: () => "Run `echo only-mode-start` in the shell and tell me exactly what it printed.",
    check: (_d, t) => (/only-mode-start/.test(t) ? null : "output not echoed"),
  },
  {
    prompt: (d) => `Create the file ${d}/notes.txt containing exactly one line: alpha`,
    check: (d) => (has(`${d}/notes.txt`) && read(`${d}/notes.txt`).includes("alpha") ? null : "notes.txt missing/wrong"),
  },
  {
    prompt: (d) => `Read ${d}/notes.txt and quote its exact contents back to me.`,
    check: (_d, t) => (/alpha/.test(t) ? null : "content not quoted"),
  },
  {
    prompt: (d) => `Search ${d} for files containing the string "alpha". Which files matched?`,
    check: (_d, t) => (/notes\.txt/.test(t) ? null : "match not reported"),
  },
  {
    prompt: (d) => `List every .txt file under ${d} using Glob (empty grep pattern + glob), and name them.`,
    check: (_d, t) => (/notes\.txt/.test(t) ? null : "glob did not name notes.txt"),
  },
  {
    prompt: (d) => `Delete ${d}/notes.txt.`,
    check: (d) => (!has(`${d}/notes.txt`) ? null : "notes.txt still exists"),
  },
];

function classifyCall(call: { name: string; arguments?: Record<string, unknown> }): "ok" | "leak" | "empty" | "bad" {
  if (call.name !== "codemode") return "leak";
  const code = call.arguments?.code;
  if (typeof code !== "string" || code.trim() === "") return "empty";
  if (!/tools\.(bash|read|write|grep|find)\s*\(/.test(code)) return "bad";
  return "ok";
}

const dir = fs.mkdtempSync(path.join("/var/tmp/pi", "probe-only-mode-"));
const token = loadAccess();
const sessionId = crypto.randomUUID();
const modelId = process.env.PROBE_MODEL ?? "composer-2.5";
const messages: IrMessage[] = [];

interface TurnReport {
  turn: number;
  ok: boolean;
  tools: number;
  calls: string[];
  misses: number;
  derail: boolean;
  reason?: string;
  text?: string;
}

const reports: TurnReport[] = [];
let logOffset = 0;

for (let i = 0; i < TURNS.length; i += 1) {
  const spec = TURNS[i]!;
  messages.push({ role: "user", text: spec.prompt(dir) });
  const calls: string[] = [];
  let text = "";
  let leak: string | undefined;
  let badScript: string | undefined;
  let okScripts = 0;
  let emptyCalls = 0;

  for (let round = 0; round < 8; round += 1) {
    const result = await runAgentSession({
      token,
      ir: { sessionId, systemPrompt: "", messages, tools: ONLY_MODE_TOOLS, modelId, maxMode: false, contextWindow: 200_000 },
      hooks: {},
    });
    let call: { id: string; name: string; arguments?: Record<string, unknown> } | undefined;
    for (const e of result.events) {
      if (e.type === "text") text += e.delta;
      if (e.type === "tool_call" && !call) call = { id: e.id, name: e.name, arguments: e.arguments ?? {} };
    }
    if (!call) break;
    const kind = classifyCall(call);
    if (kind === "leak") leak ??= `leaked declared tool ${call.name}`;
    else if (kind === "bad") badScript ??= "code is not a nested tools.* script";
    else if (kind === "empty") emptyCalls += 1;
    else okScripts += 1;
    calls.push(`${call.name} ${JSON.stringify(call.arguments).slice(0, 120)}`);
    const res = fakePiExecute(call.name, call.arguments ?? {});
    messages.push({ role: "assistant", toolCalls: [{ id: call.id, name: call.name, arguments: call.arguments ?? {} }] });
    messages.push({
      role: "tool",
      toolResult: { toolCallId: call.id, toolName: call.name, result: res.text, isError: res.isError },
    });
  }
  messages.push({ role: "assistant", text });

  const bad = badEventsSince(logOffset);
  logOffset = bad.offset;
  const derail = DERAIL.test(text);
  let reason: string | undefined;
  if (calls.length === 0) reason = "no tool call this turn";
  else if (leak) reason = leak;
  else if (badScript) reason = badScript;
  else if (okScripts === 0) reason = emptyCalls > 0 ? "only empty codemode calls" : "no nested tools.* script";
  else reason = spec.check(dir, text) ?? undefined;
  if (bad.count > 0) reason = `${reason ? reason + "; " : ""}${bad.count} provider reject/decode events`;
  if (derail) reason = `${reason ? reason + "; " : ""}derailment language in reply`;

  const report: TurnReport = {
    turn: i + 1,
    ok: reason === undefined,
    tools: calls.length,
    calls,
    misses: bad.count,
    derail,
    ...(reason !== undefined ? { reason } : {}),
    ...(reason !== undefined ? { text: text.slice(0, 400) } : {}),
  };
  reports.push(report);
  console.log(
    `turn ${String(i + 1).padStart(2)}/${TURNS.length} ${report.ok ? "ok  " : "FAIL"} tools=${calls.length} misses=${bad.count}${reason ? ` — ${reason}` : ""}`,
  );
  if (!report.ok && bad.samples.length > 0) console.log(`  sample: ${bad.samples[0]}`);
  if (!report.ok && report.calls.length > 0) console.log(`  calls: ${report.calls.join(" | ")}`);
}

const failed = reports.filter((r) => !r.ok);
console.log(
  JSON.stringify(
    {
      ok: failed.length === 0,
      mode: "only",
      model: modelId,
      turns: reports.length,
      failed: failed.length,
      totalToolCalls: reports.reduce((n, r) => n + r.tools, 0),
      totalMisses: reports.reduce((n, r) => n + r.misses, 0),
      failures: failed.map((f) => ({ turn: f.turn, reason: f.reason, calls: f.calls, text: f.text })),
    },
    null,
    1,
  ),
);
process.exitCode = failed.length === 0 ? 0 : 1;
