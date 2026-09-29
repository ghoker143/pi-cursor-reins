// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Edge-case battery for daily-use robustness. Each scenario is its own
 * one-turn conversation (isolation); the probe plays Pi.
 *
 *   node --experimental-strip-types tools/probe-edge.ts [scenario|all]
 *
 * Scenarios exercise the paths a real session hits: shell quoting, non-zero
 * exits, missing files, unicode, spacey filenames (delete composite), long
 * commands (per-exec heartbeat), and large outputs.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

process.env.CURSOR_PROVIDER_DEBUG = "1";

const { runAgentSession } = await import("../src/agent/index.ts");
const { fakePiExecute, loadAccess, TOOLS } = await import("./lib/fake-pi.ts");
import type { IrMessage } from "../src/session/ir.ts";

interface Edge {
  prompt: (dir: string) => string;
  check: (dir: string, text: string, calls: string[]) => string | null;
}

const has = (p: string) => fs.existsSync(p);

const EDGES: Record<string, Edge> = {
  quoting: {
    prompt: () => `Run exactly this in the shell: printf '%s\\n' 'a"b' '$HOME' '中文标点' — then quote the three output lines verbatim.`,
    check: (_d, t) => (/a"b/.test(t) && /\$HOME/.test(t) && /中文标点/.test(t) ? null : "quoted output mismatch"),
  },
  exitcode: {
    prompt: () => "Run `sh -c 'echo out; echo err >&2; exit 3'` in the shell and tell me whether it succeeded and what it printed.",
    check: (_d, t) => (/3|fail|error|非零|失败/i.test(t) && /out/.test(t) ? null : "failure not reported"),
  },
  "read-missing": {
    prompt: (d) => `Read the file ${d}/does-not-exist.txt and tell me what it says.`,
    check: (_d, t) => (/not|no such|missing|不存在|无法|doesn't exist/i.test(t) ? null : "missing-file error not conveyed"),
  },
  unicode: {
    prompt: (d) => `Create ${d}/uni.txt with exactly this content: héllo 中文 ✓`,
    check: (d) => (has(`${d}/uni.txt`) && fs.readFileSync(`${d}/uni.txt`, "utf8").includes("héllo 中文 ✓") ? null : "unicode content wrong"),
  },
  "spacey-delete": {
    prompt: (d) => `Delete the file "${d}/my file.txt" (mind the space in the name). Confirm when gone.`,
    check: (d) => (!has(`${d}/my file.txt`) ? null : "spacey file still exists"),
  },
  "long-cmd": {
    prompt: () => "Run `sleep 5 && echo long-done` in the shell (it takes a few seconds — wait for it), then tell me what it printed.",
    check: (_d, t) => (/long-done/.test(t) ? null : "long command output missing"),
  },
  "big-output": {
    prompt: () => "Run `seq 1 2000` in the shell and tell me only the LAST number it printed.",
    check: (_d, t) => (/2000/.test(t) ? null : "last number not reported"),
  },
};

const which = process.argv[2] ?? "all";
const names = which === "all" ? Object.keys(EDGES) : [which];
const token = loadAccess();
const modelId = process.env.PROBE_MODEL ?? "grok-4.7";

let failures = 0;
for (const name of names) {
  const edge = EDGES[name];
  if (!edge) {
    console.error(`unknown edge ${name}; have: ${Object.keys(EDGES).join(", ")}`);
    process.exit(2);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `probe-edge-${name}-`));
  if (name === "spacey-delete") fs.writeFileSync(path.join(dir, "my file.txt"), "spacey\n");

  const messages: IrMessage[] = [{ role: "user", text: edge.prompt(dir) }];
  const calls: string[] = [];
  let text = "";
  const sessionId = crypto.randomUUID(); // one conversation per scenario; rounds resume it
  try {
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
      messages.push({ role: "tool", toolResult: { toolCallId: call.id, toolName: call.name, result: res.text, isError: res.isError } });
    }
    const reason = calls.length === 0 ? "no tool call" : edge.check(dir, text, calls);
    if (reason === null) console.log(`edge ${name}: OK (${calls.length} calls)`);
    else {
      failures += 1;
      console.log(`edge ${name}: FAIL — ${reason}\n  calls: ${JSON.stringify(calls)}\n  text: ${text.slice(0, 200)}`);
    }
  } catch (err) {
    failures += 1;
    console.log(`edge ${name}: CRASH — ${String(err).slice(0, 300)}`);
  }
}
console.log(JSON.stringify({ ok: failures === 0, model: modelId, ran: names.length, failures }));
process.exitCode = failures === 0 ? 0 : 1;
