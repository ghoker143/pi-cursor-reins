// SPDX-License-Identifier: AGPL-3.0-or-later
import { EXEC_CASES, type DecodedExec, type ExecCase, encodeEmpty, encodeNested, encodeStringField } from "../proto/agent.ts";
import { LOCAL_TOOL_LOOP_MESSAGE, NATIVE_EXEC_REJECT } from "../errors.ts";
import { encodeFields, writeBool, writeInt32, writeString } from "../proto/wire.ts";
import type { IrTool } from "../session/ir.ts";

export { EXEC_CASES };
export type { ExecCase };

/** Exact-name aliases first (if a Pi setup registers these classic names). */
const LOCAL_HINTS: Record<string, string[]> = {
  shellArgs: ["bash"],
  shellStreamArgs: ["bash"],
  backgroundShellSpawnArgs: ["bash"],
  writeShellStdinArgs: ["bash"],
  readArgs: ["read", "Read"],
  lsArgs: ["ls", "LS"],
  grepArgs: ["grep", "Grep"],
  writeArgs: ["write", "Write", "edit", "Edit"],
  deleteArgs: ["bash"],
};

/**
 * Name fragments that signal a tool can serve each native case, most specific first.
 * Ranked against the ACTUAL registered tool names — never assume a fixed tool exists.
 */
const CAPABILITY_FRAGMENTS: Record<string, string[]> = {
  shellArgs: ["ctx_shell", "shell", "exec", "bash", "run"],
  shellStreamArgs: ["ctx_shell", "shell", "exec", "bash", "run"],
  backgroundShellSpawnArgs: ["ctx_shell", "bg_run", "shell", "exec", "bash"],
  writeShellStdinArgs: ["ctx_shell", "shell", "exec", "bash"],
  startGrindExecutionArgs: ["ctx_shell", "shell", "exec", "bash"],
  startGrindPlanningArgs: ["ctx_shell", "shell", "exec"],
  readArgs: ["read", "cat", "view"],
  lsArgs: ["ls", "ffind", "find", "ffgrep"],
  grepArgs: ["grep", "search", "ffind"],
  writeArgs: ["write", "edit"],
  deleteArgs: ["ctx_shell", "shell", "exec", "bash"],
  fetchArgs: ["fetch", "web_search", "source_check"],
  diagnosticsArgs: ["diagnostics", "lsp"],
  computerUseArgs: ["browser"],
  recordScreenArgs: ["browser"],
};

const CASE_INTENT: Record<string, string> = {
  shellArgs: "run that command",
  shellStreamArgs: "run that command",
  backgroundShellSpawnArgs: "run that background command",
  writeShellStdinArgs: "feed that shell input",
  startGrindPlanningArgs: "plan the work",
  startGrindExecutionArgs: "execute that step",
  readArgs: "read that file",
  lsArgs: "list that directory",
  grepArgs: "run that search",
  writeArgs: "write that file",
  deleteArgs: "delete that file",
  fetchArgs: "fetch that URL",
  diagnosticsArgs: "get those diagnostics",
};

/** Rank registered tools by how well they can serve this native case. Best first.
 *
 * Signals, strongest first: exact alias → capability word in the NAME → (command
 * intents) a command-ish property in the tool's own JSON SCHEMA → capability word
 * in the DESCRIPTION. The last two are zero-maintenance: they adapt to any pi
 * tool naming, because pi already ships schemas and descriptions in the IR. */
const COMMAND_INTENT_CASES = new Set([
  "shellArgs",
  "shellStreamArgs",
  "backgroundShellSpawnArgs",
  "writeShellStdinArgs",
  "startGrindExecutionArgs",
  "startGrindPlanningArgs",
  "deleteArgs",
]);
const COMMAND_SCHEMA_KEYS = ["command", "cmd", "script", "shell"];

export function schemaProperties(tool: IrTool): string[] {
  return Object.keys((tool.jsonSchema as { properties?: Record<string, unknown> })?.properties ?? {});
}

export function rankedTools(execCase: string, tools: IrTool[]): IrTool[] {
  const hints = LOCAL_HINTS[execCase] ?? [];
  const fragments = CAPABILITY_FRAGMENTS[execCase] ?? [];
  const commandIntent = COMMAND_INTENT_CASES.has(execCase);
  const score = (tool: IrTool): number => {
    if (hints.includes(tool.name)) return 4000;
    const nameHit = fragments.findIndex((f) => tool.name.toLowerCase().includes(f));
    if (nameHit !== -1) return 3000 - nameHit;
    if (commandIntent) {
      const keys = schemaProperties(tool).map((k) => k.toLowerCase());
      if (keys.some((k) => COMMAND_SCHEMA_KEYS.includes(k))) return 2000;
    }
    const descHit = fragments.findIndex((f) => tool.description.toLowerCase().includes(f));
    if (descHit !== -1) return 1000 - Math.min(descHit, 9);
    return 0;
  };
  return tools
    .map((tool, index) => ({ tool, index, s: score(tool) }))
    .sort((a, b) => b.s - a.s || a.index - b.index)
    .map((row) => row.tool);
}

/** Best tool for running commands, for loop-guard and policy hints. */
export function bestCommandTool(tools: IrTool[]): IrTool | undefined {
  return rankedTools("shellArgs", tools)[0];
}

/**
 * Rank alternatives for a tool_not_found reply: tools sharing a capability
 * word with the requested name first (e.g. "sudo_exec" → "ctx_execute"),
 * then longest common prefix, then registration order.
 */
const ALL_FRAGMENTS = [...new Set(Object.values(CAPABILITY_FRAGMENTS).flat())].sort((a, b) => b.length - a.length);

export function rankAlternatives(requested: string, available: string[]): string[] {
  const want = requested.toLowerCase();
  const hits = ALL_FRAGMENTS.filter((f) => want.includes(f));
  const commonPrefix = (name: string): number => {
    let i = 0;
    while (i < want.length && i < name.length && want[i] === name[i]) i += 1;
    return i;
  };
  const score = (name: string): number => {
    const lower = name.toLowerCase();
    const fragment = hits.some((f) => lower.includes(f)) ? 100 : 0;
    const stem = (lower.startsWith(want) || want.startsWith(lower)) ? 50 : 0;
    const prefix = commonPrefix(lower) >= 3 ? commonPrefix(lower) : 0;
    return fragment + stem + prefix;
  };
  return available
    .map((name, index) => ({ name, index, s: score(name) }))
    .sort((a, b) => b.s - a.s || a.index - b.index)
    .map((row) => row.name);
}

/** Message for an exec case we cannot even classify (protocol drift / new native tool). */
export function unknownExecThrowMessage(execCase: string, tools: IrTool[]): string {
  const best = bestCommandTool(tools);
  return (
    `Pi Cursor provider has no handler for exec case "${execCase}". ${LOCAL_TOOL_LOOP_MESSAGE}` +
    (best ? ` To run commands, call the MCP tool \`${cursorMcpToolName(best.name)}\`.` : "")
  );
}

/** A concrete argument example derived from the tool's own JSON schema. */
function argHintFor(tool: IrTool, detail: string): string {
  const props = Object.keys((tool.jsonSchema as { properties?: Record<string, unknown> })?.properties ?? {});
  const key = ["command", "path", "pattern", "url", "query", "script"].find((k) => props.includes(k));
  if (!key) return " with the original request as arguments";
  // Even without a concrete value (the native frame carried none) name the parameter:
  // a model that cannot see the tool schema otherwise calls the tool bare and pi's own
  // arg validation rejects it, costing a whole extra round trip.
  const value = detail === "" ? '"…"' : JSON.stringify(detail);
  return ` with {"${key}": ${value}}`;
}

export function cursorMcpToolName(toolName: string): string {
  const name = toolName.trim();
  if (name.startsWith("mcp_pi_")) return name;
  return `mcp_pi_${name || "tool"}`;
}

export function stripCursorMcpToolName(toolName: string): string {
  const name = toolName.trim();
  return name.startsWith("mcp_pi_") ? name.slice("mcp_pi_".length) : name;
}

export function rejectReason(execCase: string, tools: IrTool[], detail = "", escalated = false): string {
  const intent = CASE_INTENT[execCase] ?? "do this";
  if (tools.length === 0) {
    return `${NATIVE_EXEC_REJECT} No Pi MCP tools are exposed for this request, so this cannot be performed.`;
  }
  const ranked = rankedTools(execCase, tools);
  const [best, ...others] = ranked;
  if (!best) return `${NATIVE_EXEC_REJECT} No Pi MCP tools are exposed for this request, so this cannot be performed.`;
  const bestName = cursorMcpToolName(best.name);
  const example = argHintFor(best, detail);
  if (escalated) {
    // Repeated misses mean the first wording did not land. Drop the explanation and
    // give one imperative instruction plus a copy-pasteable call, nothing else.
    return (
      `${NATIVE_EXEC_REJECT} STOP calling Cursor native tools — they are disabled and no operation was performed. ` +
      `Emit exactly one call to \`${bestName}\` (Pi MCP dynamic tool, namespace "pi", id \`${best.name}\`)${example}, ` +
      `or reply with plain text.`
    );
  }
  const alternates = others.slice(0, 2).map((t) => cursorMcpToolName(t.name));
  return (
    `${NATIVE_EXEC_REJECT} To ${intent} from Pi, call the MCP tool \`${bestName}\`${example}.` +
    (alternates.length > 0 ? ` Usable alternatives: ${alternates.join(", ")}.` : "")
  );
}

/**
 * `name(arg, arg)`. Cursor's dynamic-tool listing does not always hand the model the
 * input schemas (measured 2026-09-28: `GetDynamicTools` misses the `pi` namespace while
 * `CallDynamicTool` works), and a model without the schema calls the tool bare — pi then
 * rejects the call on its own argument validation, costing a round trip and sometimes the
 * whole turn. Names are cheap; guessing is not.
 */
function argSummary(tool: IrTool): string {
  const schema = tool.jsonSchema as { properties?: Record<string, unknown>; required?: unknown };
  const props = Object.keys(schema.properties ?? {});
  const required = Array.isArray(schema.required)
    ? schema.required.filter((r): r is string => typeof r === "string" && props.includes(r))
    : [];
  const names = (required.length > 0 ? required : props).slice(0, 4);
  const label = cursorMcpToolName(tool.name);
  return names.length > 0 ? `${label}(${names.join(", ")})` : label;
}

export function localToolPolicyText(tools: IrTool[]): string {
  const names = tools.map((t) => cursorMcpToolName(t.name));
  const lines = [
    "Local file reads, searches, directory listings, writes, deletions and shell commands must use Pi MCP tools. " +
      "Native Cursor local tools (shell, read, grep, write, grind, …) are disabled; do not call or retry them.",
    // Learned live (grok-4.7 / composer-2.5, 2026-09-28): these tools do not always appear
    // in the model's static tool list, and `GetDynamicTools` does not reliably enumerate the
    // `pi` namespace either. Models that read that as "Pi is unavailable" fall back to
    // (rejected) native tools until the loop guard kills the turn. Say the tools are
    // callable anyway, and carry each tool's argument names inline so a model without the
    // schema still calls it correctly instead of guessing (guessing costs a pi-side
    // validation failure and a round trip).
    "Pi MCP tools reach you as Cursor dynamic tools in the MCP namespace \"pi\" (model-facing ids look like `mcp_pi_<name>`). " +
      'They stay callable even when your tool list omits them: call CallDynamicTool with namespace "pi" and the id below. ' +
      "That GetDynamicTools cannot enumerate the namespace is NOT a reason to fall back to Cursor native tools.",
  ];
  const cmd = rankedTools("shellArgs", tools)[0];
  const read = rankedTools("readArgs", tools)[0];
  const search = rankedTools("grepArgs", tools)[0];
  const edit = rankedTools("writeArgs", tools)[0];
  if (cmd) lines.push(`Run commands with ${cursorMcpToolName(cmd.name)} ({"command": "…"}).`);
  if (read) lines.push(`Read files with ${cursorMcpToolName(read.name)}.`);
  if (search) lines.push(`Search with ${cursorMcpToolName(search.name)}.`);
  if (edit && edit !== cmd) lines.push(`Edit/write files with ${cursorMcpToolName(edit.name)}.`);
  lines.push(
    names.length > 0
      ? `Registered Pi MCP tools, with their arguments: ${tools.map(argSummary).join(", ")}. ` +
          "Follow each tool's input schema; every call needs its required arguments."
      : "No Pi MCP tools are exposed for this request. Local operations are unavailable.",
  );
  return lines.join(" ");
}

export type ExecDecision =
  | { action: "mcp" }
  | { action: "context" }
  | { action: "throw" }
  /** `ack` marks an empty success that performs no local work (Cursor-side UI affordance). */
  | { action: "reject"; resultField: number; resultBytes: Uint8Array; ack?: true };

function pathOr(exec: DecodedExec): string {
  return exec.strings.path ?? exec.strings.command ?? "";
}

function shellRejected(exec: DecodedExec, reason: string): Uint8Array {
  return encodeFields((w) => {
    writeString(w, 1, exec.strings.command ?? "");
    writeString(w, 2, exec.strings.workingDirectory ?? "");
    writeString(w, 3, reason);
    writeBool(w, 4, false);
  });
}

function pathRejected(exec: DecodedExec, reason: string): Uint8Array {
  return encodeFields((w) => {
    writeString(w, 1, pathOr(exec));
    writeString(w, 2, reason);
  });
}

/** Completeness table: every EXEC_CASES row must hit a branch. PROTOCOL-AGENT §5. */
export function decideExec(exec: DecodedExec, tools: IrTool[], escalated = false): ExecDecision {
  const detail = exec.strings.command ?? exec.strings.path ?? exec.strings.url ?? exec.strings.uri ?? "";
  const reason = rejectReason(exec.case, tools, detail, escalated);
  switch (exec.case) {
    case "mcpArgs":
      return { action: "mcp" };
    case "requestContextArgs":
      return { action: "context" };
    case "setupVmEnvironmentArgs":
    case "unknown":
      return { action: "throw" };
    case "shellArgs":
      return { action: "reject", resultField: 2, resultBytes: encodeNested(4, shellRejected(exec, reason)) };
    case "writeArgs":
      return { action: "reject", resultField: 3, resultBytes: encodeNested(6, pathRejected(exec, reason)) };
    case "deleteArgs":
      return { action: "reject", resultField: 4, resultBytes: encodeNested(6, pathRejected(exec, reason)) };
    case "grepArgs":
      return { action: "reject", resultField: 5, resultBytes: encodeNested(2, encodeStringField(1, reason)) };
    case "readArgs":
      return { action: "reject", resultField: 7, resultBytes: encodeNested(3, pathRejected(exec, reason)) };
    case "lsArgs":
      return { action: "reject", resultField: 8, resultBytes: encodeNested(3, pathRejected(exec, reason)) };
    case "diagnosticsArgs":
      return { action: "reject", resultField: 9, resultBytes: encodeNested(3, pathRejected(exec, reason)) };
    case "shellStreamArgs":
      return { action: "reject", resultField: 14, resultBytes: encodeNested(5, shellRejected(exec, reason)) };
    case "backgroundShellSpawnArgs":
      return { action: "reject", resultField: 16, resultBytes: encodeNested(3, shellRejected(exec, reason)) };
    case "listMcpResourcesExecArgs":
      return { action: "reject", resultField: 17, resultBytes: encodeNested(3, encodeStringField(1, reason)) };
    case "readMcpResourceExecArgs":
      return {
        action: "reject",
        resultField: 18,
        resultBytes: encodeNested(
          3,
          encodeFields((w) => {
            writeString(w, 1, exec.strings.uri ?? exec.strings.path ?? "");
            writeString(w, 2, reason);
          }),
        ),
      };
    case "fetchArgs":
      return {
        action: "reject",
        resultField: 20,
        resultBytes: encodeNested(
          2,
          encodeFields((w) => {
            writeString(w, 1, exec.strings.url ?? "");
            writeString(w, 2, reason);
          }),
        ),
      };
    case "recordScreenArgs":
      return { action: "reject", resultField: 21, resultBytes: encodeNested(4, encodeStringField(1, reason)) };
    case "computerUseArgs":
      return {
        action: "reject",
        resultField: 22,
        resultBytes: encodeNested(
          2,
          encodeFields((w) => {
            writeString(w, 1, reason);
            writeInt32(w, 2, 0);
            writeInt32(w, 3, 0);
          }),
        ),
      };
    case "writeShellStdinArgs":
      return { action: "reject", resultField: 23, resultBytes: encodeNested(2, encodeStringField(1, reason)) };
    case "reflectArgs":
      return { action: "reject", resultField: 32, resultBytes: encodeNested(2, encodeStringField(1, reason)) };
    case "truncatedToolCallArgs":
      return { action: "reject", resultField: 34, resultBytes: encodeNested(2, encodeStringField(1, reason)) };
    case "startGrindExecutionArgs":
      return { action: "reject", resultField: 35, resultBytes: encodeNested(2, encodeStringField(1, reason)) };
    case "startGrindPlanningArgs":
      // Plan mode is a Cursor-side UI affordance, not local execution. The error arm made
      // grok-4.7 re-request it until the loop guard killed the turn (measured 2026-09-28);
      // the empty success ack lets the model move on to real mcp_args calls. No local
      // work happens either way, so the audit invariant is untouched.
      return { action: "reject", resultField: 36, resultBytes: encodeNested(1, encodeEmpty()), ack: true };
  }
}

export function interactionApprove(resultField: number): Uint8Array {
  return encodeNested(1, new Uint8Array());
}

export function interactionRejectString(resultField: number, reason: string): Uint8Array {
  return encodeNested(2, encodeStringField(1, reason));
}

export function askQuestionError(reason: string): Uint8Array {
  return encodeNested(1, encodeNested(2, encodeStringField(1, reason)));
}

export function createPlanError(reason: string): Uint8Array {
  return encodeNested(1, encodeNested(2, encodeStringField(1, reason)));
}

export function setupVmAck(): Uint8Array {
  return encodeNested(1, new Uint8Array());
}
