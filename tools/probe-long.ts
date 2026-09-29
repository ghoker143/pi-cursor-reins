// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * 20-turn long-conversation compliance probe against the live backend.
 *
 *   node --experimental-strip-types tools/probe-long.ts
 *
 * One conversation, 20 user turns, each turn requires at least one tool call.
 * Runs with CURSOR_PROVIDER_NATIVE_EXEC=pi (native translation). The probe
 * plays Pi (tools/lib/fake-pi.ts) and feeds results back as tool_result
 * messages on resume, like a real pi session.
 *
 * Per turn it records:
 *   - tools:   how many translated tool_calls the model made (0 = compliance fail)
 *   - check:   the turn's side-effect/content assertion
 *   - misses:  provider-side rejects/decode errors observed in the debug log
 *   - derail:  model text matched a "tools are broken/unavailable" pattern
 *
 * Exit 0 only if every turn passes every metric.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.CURSOR_PROVIDER_DEBUG = "1"; // native translation (pi) is the default; no env to set

const { runAgentSession } = await import("../src/agent/index.ts");
const { fakePiExecute, loadAccess, TOOLS } = await import("./lib/fake-pi.ts");
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

interface Turn {
  prompt: (dir: string) => string;
  check: (dir: string, text: string) => string | null;
}

const read = (p: string) => fs.readFileSync(p, "utf8");
const has = (p: string) => fs.existsSync(p);

const TURNS: Turn[] = [
  {
    prompt: () => "Run `echo long-probe-start` in the shell and tell me exactly what it printed.",
    check: (_d, t) => (/long-probe-start/.test(t) ? null : "output not echoed"),
  },
  {
    prompt: (d) => `Create the file ${d}/notes.txt containing exactly one line: alpha`,
    check: (d) => (has(`${d}/notes.txt`) && read(`${d}/notes.txt`).includes("alpha") ? null : "notes.txt missing/wrong"),
  },
  {
    prompt: (d) => `Append one line "beta" to ${d}/notes.txt using the shell.`,
    check: (d) => (read(`${d}/notes.txt`).includes("beta") ? null : "beta not appended"),
  },
  {
    prompt: (d) => `Read ${d}/notes.txt and quote its exact contents back to me.`,
    check: (_d, t) => (/alpha/.test(t) && /beta/.test(t) ? null : "content not quoted"),
  },
  {
    prompt: (d) => `Search the directory ${d} for files containing the string "beta". Which files matched?`,
    check: (_d, t) => (/notes\.txt/.test(t) ? null : "match not reported"),
  },
  {
    prompt: (d) => `Create the file ${d}/data/a.log with the content "needle-1".`,
    check: (d) => (has(`${d}/data/a.log`) && read(`${d}/data/a.log`).includes("needle-1") ? null : "a.log missing/wrong"),
  },
  {
    prompt: (d) => `List all .txt files directly inside ${d} (use whatever of your tools fits best).`,
    check: (_d, t) => (/notes\.txt/.test(t) ? null : "notes.txt not listed"),
  },
  {
    prompt: (d) => `Using the shell, create three files ${d}/f1.tmp, ${d}/f2.tmp, ${d}/f3.tmp — each containing its own file name.`,
    check: (d) => (["f1.tmp", "f2.tmp", "f3.tmp"].every((f) => has(`${d}/${f}`)) ? null : "tmp files missing"),
  },
  {
    prompt: (d) => `Which files in ${d} match the glob f*.tmp? List them.`,
    check: (_d, t) => (/f1\.tmp/.test(t) && /f2\.tmp/.test(t) ? null : "glob result not reported"),
  },
  {
    prompt: (d) => `Delete the file ${d}/f3.tmp.`,
    check: (d) => (!has(`${d}/f3.tmp`) ? null : "f3.tmp still exists"),
  },
  {
    prompt: (d) => `Read ${d}/data/a.log and tell me the exact string stored inside.`,
    check: (_d, t) => (/needle-1/.test(t) ? null : "needle-1 not quoted"),
  },
  {
    prompt: (d) => `Count how many lines under ${d} (recursively) contain the string "needle". Tell me the count.`,
    check: (_d, t) => (/needle|a\.log|\b1\b/.test(t) ? null : "count not reported"),
  },
  {
    prompt: (d) => `Rename ${d}/notes.txt to ${d}/notes-renamed.txt using the shell.`,
    check: (d) => (has(`${d}/notes-renamed.txt`) && !has(`${d}/notes.txt`) ? null : "rename failed"),
  },
  {
    prompt: (d) => `List the .txt files in ${d} again — what do you see now?`,
    check: (_d, t) => (/notes-renamed\.txt/.test(t) ? null : "renamed file not listed"),
  },
  {
    prompt: (d) => `Check which files are currently in ${d} (any tool), then write ${d}/summary.md containing that file list.`,
    check: (d) => (has(`${d}/summary.md`) && read(`${d}/summary.md`).includes("notes-renamed") ? null : "summary.md missing/incomplete"),
  },
  {
    prompt: (d) => `Delete ${d}/data/a.log.`,
    check: (d) => (!has(`${d}/data/a.log`) ? null : "a.log still exists"),
  },
  {
    prompt: (d) => `Use the shell to show the line count of every remaining file under ${d}.`,
    check: (_d, t) => (/\d/.test(t) ? null : "no counts reported"),
  },
  {
    prompt: (d) => `Read ${d}/summary.md back and quote it.`,
    check: (_d, t) => (/notes-renamed/.test(t) ? null : "summary not quoted"),
  },
  {
    prompt: (d) => `Delete ${d}/f1.tmp and ${d}/f2.tmp.`,
    check: (d) => (!has(`${d}/f1.tmp`) && !has(`${d}/f2.tmp`) ? null : "tmp files still exist"),
  },
  {
    prompt: (d) => `Clean up: remove everything left inside ${d} (files and subdirectories), then confirm the directory is empty.`,
    check: (d) => {
      try {
        return fs.readdirSync(d).length === 0 ? null : `leftovers: ${fs.readdirSync(d).join(",")}`;
      } catch {
        return null; // workspace dir itself was removed — acceptable
      }
    },
  },
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "probe-long-"));
const token = loadAccess();
const sessionId = crypto.randomUUID();
const modelId = process.env.PROBE_MODEL ?? "grok-4.7";
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
  if (i >= Number(process.env.PROBE_TURNS ?? TURNS.length)) break;
  const spec = TURNS[i]!;
  messages.push({ role: "user", text: spec.prompt(dir) });
  const calls: string[] = [];
  let text = "";

  for (let round = 0; round < 8; round += 1) {
    const result = await runAgentSession({
      token,
      ir: { sessionId, systemPrompt: "", messages, tools: TOOLS, modelId, maxMode: false, contextWindow: 200_000 },
      hooks: {},
    });
    let call: { id: string; name: string; arguments?: Record<string, unknown> } | undefined;
    for (const e of result.events) {
      if (e.type === "text") text += e.delta;
      if (e.type === "tool_call" && !call) call = { id: e.id, name: e.name, arguments: e.arguments ?? {} };
    }
    if (!call) break;
    calls.push(`${call.name} ${JSON.stringify(call.arguments).slice(0, 80)}`);
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
  console.log(`turn ${String(i + 1).padStart(2)}/20 ${report.ok ? "ok  " : "FAIL"} tools=${calls.length} misses=${bad.count}${reason ? ` — ${reason}` : ""}`);
  if (!report.ok && bad.samples.length > 0) console.log(`  sample: ${bad.samples[0]}`);
}

const failed = reports.filter((r) => !r.ok);
console.log(
  JSON.stringify(
    {
      ok: failed.length === 0,
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
