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
        const r = spawnSync(
          "find",
          [String(args.path ?? "."), "-name", String(args.pattern ?? "*"), "-type", "f"],
          { encoding: "utf8", timeout: 20_000 },
        );
        return { text: (r.stdout ?? "") + (r.stderr ?? ""), isError: r.status !== 0 };
      }
      default:
        return { text: `probe has no executor for ${name}`, isError: true };
    }
  } catch (err) {
    return { text: String(err), isError: true };
  }
}
