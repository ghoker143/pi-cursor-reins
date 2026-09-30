// SPDX-License-Identifier: AGPL-3.0-or-later
/** Shared helpers for the live probes: credentials, a pi-shaped tool set, and
 * a local executor that plays the Pi side of translated tool calls. */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export function loadAccess(): string {
  const env = process.env.PI_CURSOR_TOKEN;
  if (env && env !== "") return env;
  for (const p of [
    join(homedir(), ".pi/agent/auth.json"),
    join(homedir(), ".config/pi/agent/auth.json"),
  ]) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf8")) as { cursor?: { access?: string } };
      if (raw.cursor?.access) return raw.cursor.access;
    } catch {
      /* next */
    }
  }
  throw new Error("no cursor credential");
}

export const CODEMODE_TOOL = {
  name: "codemode",
  description:
    "Run JavaScript that calls bash, shell, read, write, grep, and find. Hidden builtins stay callable via tools.bash / tools.read / tools.write.",
  jsonSchema: { type: "object", properties: { code: { type: "string" } }, required: ["code"] },
};

/** Catalog shape of `codemode.mode=only`: builtins hidden, only the script tool is declared. */
export const ONLY_MODE_TOOLS = [CODEMODE_TOOL];

function parseObjectLiteral(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    const jsonish = raw.replace(/([,{]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":');
    return JSON.parse(jsonish) as Record<string, unknown>;
  }
}

function nestedToolCalls(code: string): { name: string; args: Record<string, unknown> }[] {
  const out: { name: string; args: Record<string, unknown> }[] = [];
  const prefix = /tools\.(bash|read|write|grep|find)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = prefix.exec(code))) {
    const start = match.index + match[0].length;
    if (code[start] !== "{") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let i = start;
    for (; i < code.length; i += 1) {
      const c = code[i]!;
      if (inStr) {
        if (esc) {
          esc = false;
          continue;
        }
        if (c === "\\") {
          esc = true;
          continue;
        }
        if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') {
        inStr = true;
        continue;
      }
      if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
    }
    out.push({ name: match[1]!, args: parseObjectLiteral(code.slice(start, i)) });
  }
  return out;
}

function wrapCodemodeResult(text: string, isError: boolean): { text: string; isError: boolean } {
  const header = `${isError ? "Script failed" : "Script completed"}\nWall time 0.1 seconds\nOutput:\n`;
  return { text: header + text, isError };
}

function executeCodemode(code: string): { text: string; isError: boolean } {
  const calls = nestedToolCalls(code);
  if (calls.length === 0) return wrapCodemodeResult("no nested tools.* call in script", true);
  const parts: string[] = [];
  let isError = false;
  for (const call of calls) {
    const r = fakePiExecute(call.name, call.args);
    parts.push(r.text);
    if (r.isError) isError = true;
  }
  return wrapCodemodeResult(parts.join(""), isError);
}

/** The Pi tool set the probes advertise (mirrors pi's classic tools). */
export const TOOLS = [
  { name: "bash", description: "Run a shell command", jsonSchema: { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } }, required: ["command"] } },
  { name: "read", description: "Read a file", jsonSchema: { type: "object", properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] } },
  { name: "write", description: "Write a file", jsonSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "grep", description: "Search file contents", jsonSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" }, glob: { type: "string" } }, required: ["pattern"] } },
  { name: "find", description: "Find files by name pattern", jsonSchema: { type: "object", properties: { pattern: { type: "string" }, path: { type: "string" } }, required: ["pattern"] } },
];

/** Play Pi: execute the translated tool call locally, return its text result. */
export function fakePiExecute(name: string, args: Record<string, unknown>): { text: string; isError: boolean } {
  try {
    switch (name) {
      case "bash": {
        const r = spawnSync("sh", ["-c", String(args.command ?? "")], { encoding: "utf8", timeout: 20_000 });
        return { text: (r.stdout ?? "") + (r.stderr ?? ""), isError: r.status !== 0 };
      }
      case "read": {
        const lines = fs.readFileSync(String(args.path), "utf8").split("\n");
        const offset = typeof args.offset === "number" ? args.offset : 0;
        const limit = typeof args.limit === "number" ? args.limit : 0;
        return { text: lines.slice(offset, limit > 0 ? offset + limit : undefined).join("\n"), isError: false };
      }
      case "write": {
        fs.mkdirSync(path.dirname(String(args.path)), { recursive: true });
        fs.writeFileSync(String(args.path), String(args.content ?? ""));
        return { text: "File written successfully", isError: false };
      }
      case "grep": {
        const r = spawnSync(
          "grep",
          ["-rIn", "--", String(args.pattern ?? ""), String(args.path ?? ".")],
          { encoding: "utf8", timeout: 20_000 },
        );
        return { text: (r.stdout ?? "") + (r.stderr ?? ""), isError: r.status === 2 };
      }
      case "find": {
        const pattern = String(args.pattern ?? "*");
        const name = pattern.replace(/^\*\*\//, "") || "*";
        const r = spawnSync(
          "find",
          [String(args.path ?? "."), "-name", name, "-type", "f"],
          { encoding: "utf8", timeout: 20_000 },
        );
        return { text: (r.stdout ?? "") + (r.stderr ?? ""), isError: r.status !== 0 };
      }
      case "codemode":
        return executeCodemode(String(args.code ?? ""));
      default:
        return { text: `probe has no executor for ${name}`, isError: true };
    }
  } catch (err) {
    return { text: String(err), isError: true };
  }
}
