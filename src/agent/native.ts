// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Native exec translation is the DEFAULT behavior: a native exec is translated
 * to a regular Pi `tool_call` (capability-matched via rankedTools, never a
 * hardcoded tool name); Pi's permission system stays the execution authority.
 * When the tool result comes back, it is encoded into the native success/error
 * wire shape (PROTOCOL-AGENT §5.1).
 *
 * The only non-default mode is **inproc** (`CURSOR_PROVIDER_NATIVE_EXEC=inproc`):
 * probe-only in-process executors used by tools/probe-native.ts to validate the
 * wire shapes against the live backend. Never for real sessions.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { matchToolFor, schemaProperties } from "./policy.ts";
import { expectBytes, expectString, expectVarint, forEachField, skipUnknown, WireType } from "../proto/wire.ts";
import type { DecodedExec } from "../proto/agent.ts";
import type { IrTool } from "../session/ir.ts";
import { debugLog } from "../transport/debug.ts";
import { encodeFields, writeBool, writeBytes, writeBytesAlways, writeInt32, writeString, writeUint32 } from "../proto/wire.ts";

export type NativeExecMode = "pi" | "inproc";

export function nativeExecMode(env: NodeJS.ProcessEnv = process.env): NativeExecMode {
  const raw = env.CURSOR_PROVIDER_NATIVE_EXEC?.trim().toLowerCase() ?? "";
  if (raw === "inproc") return "inproc";
  return "pi";
}

export interface NativeReplyFrame {
  resultField: number;
  resultBytes: Uint8Array;
  id?: number;
}

export interface NativeReply {
  frames: NativeReplyFrame[];
  /** Every native result sequence ends with ExecClientControlMessage.stream_close
   * (the reference client closes single-result execs too, not just streams —
   * without it the backend journals the result and stalls the turn). */
  closeStream: boolean;
  /** Human summary for the debug log (never sent on the wire). */
  summary: string;
}

// ---------------------------------------------------------------------------
// Typed arguments decoded from the exec payload.
// ---------------------------------------------------------------------------

export type NativeArgs =
  | { case: "shellArgs" | "shellStreamArgs"; command: string; workingDirectory: string; timeoutMs: number }
  | { case: "readArgs"; path: string }
  | { case: "writeArgs"; path: string; contents: string }
  | { case: "deleteArgs"; path: string }
  | {
      case: "grepArgs";
      pattern: string;
      glob: string;
      path: string;
      caseInsensitive: boolean;
      outputMode: string;
    };

interface ShellArgsPayload {
  command: string;
  workingDirectory: string;
  timeoutMs: number;
}

function decodeShellPayload(payload: Uint8Array): ShellArgsPayload {
  const out: ShellArgsPayload = { command: "", workingDirectory: "", timeoutMs: 0 };
  forEachField(payload, (field, wire, reader) => {
    if (field === 1) out.command = expectString(reader, wire);
    else if (field === 2) out.workingDirectory = expectString(reader, wire);
    // Field 3 is int32 `timeout`; its unit (s vs ms) is unverified, so it is
    // decoded for the debug log but never translated into a Pi tool argument.
    else if (field === 3 && wire === WireType.Varint) out.timeoutMs = Number(expectVarint(reader, wire));
    // Field 15 is a human description string on the live wire ("Run … command").
    else if (field === 15 && wire === WireType.LengthDelimited) void expectString(reader, wire);
    else skipUnknown(reader, wire, field);
  });
  return out;
}

// Live wire: ReadArgs is {path=1, tool_call_id=2} — no offset/limit (the model
// re-reads whole files; PROTOCOL-AGENT §5.1). Unknown extra fields are skipped.
function decodeReadPayload(payload: Uint8Array): { path: string } {
  const out = { path: "" };
  forEachField(payload, (field, wire, reader) => {
    if (field === 1) out.path = expectString(reader, wire);
    else skipUnknown(reader, wire, field);
  });
  return out;
}

function decodePathPayload(payload: Uint8Array): string {
  let out = "";
  forEachField(payload, (field, wire, reader) => {
    if (field === 1 && wire === WireType.LengthDelimited) out = expectString(reader, wire);
    else skipUnknown(reader, wire, field);
  });
  return out;
}

function decodeWritePayload(payload: Uint8Array): { path: string; contents: string } {
  const out = { path: "", contents: "" };
  forEachField(payload, (field, wire, reader) => {
    if (field === 1 && wire === WireType.LengthDelimited) out.path = expectString(reader, wire);
    else if (field === 2 && wire === WireType.LengthDelimited) out.contents = expectString(reader, wire);
    else skipUnknown(reader, wire, field);
  });
  return out;
}

function decodeGrepPayload(payload: Uint8Array): {
  pattern: string;
  glob: string;
  path: string;
  caseInsensitive: boolean;
  outputMode: string;
} {
  // The reconstructed proto and the live wire disagree on this message's field
  // numbering, so every field is decoded by wire type, not by assumed type.
  const out = { pattern: "", glob: "", path: "", caseInsensitive: false, outputMode: "content" };
  forEachField(payload, (field, wire, reader) => {
    if (field === 1 && wire === WireType.LengthDelimited) out.pattern = expectString(reader, wire);
    else if (field === 2 && wire === WireType.Varint) out.caseInsensitive = Boolean(expectVarint(reader, wire));
    else if (field === 2 && wire === WireType.LengthDelimited) out.path = expectString(reader, wire);
    else if (field === 3 && wire === WireType.LengthDelimited) out.glob = expectString(reader, wire);
    else if ((field === 4 || field === 6) && wire === WireType.LengthDelimited) {
      const value = expectString(reader, wire);
      if (out.path === "") out.path = value;
    } else if (field === 11 && wire === WireType.LengthDelimited) out.outputMode = expectString(reader, wire);
    else skipUnknown(reader, wire, field);
  });
  return out;
}

/** Decoded args for a translatable native exec case; null = keep the policy path. */
export function decodeNativeArgs(exec: DecodedExec): NativeArgs | null {
  switch (exec.case) {
    case "shellArgs":
    case "shellStreamArgs":
      return { case: exec.case, ...decodeShellPayload(exec.payload) };
    case "readArgs":
      return { case: "readArgs", ...decodeReadPayload(exec.payload) };
    case "writeArgs":
      return { case: "writeArgs", ...decodeWritePayload(exec.payload) };
    case "deleteArgs":
      return { case: "deleteArgs", path: decodePathPayload(exec.payload) };
    case "grepArgs":
      return { case: "grepArgs", ...decodeGrepPayload(exec.payload) };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Success/error encoders — field numbers per PROTOCOL-AGENT §5.1.
// ---------------------------------------------------------------------------

/** Nested fields the model is known to read are written even when empty. */
function writeStringAlways(w: Parameters<typeof writeString>[0], field: number, value: string): void {
  writeBytesAlways(w, field, new TextEncoder().encode(value));
}

function shellSuccess(command: string, cwd: string, exitCode: number, stdout: string, stderr: string): Uint8Array {
  return encodeFields((w) => {
    writeBytesAlways(
      w,
      1,
      encodeFields((s) => {
        writeString(s, 1, command);
        writeString(s, 2, cwd);
        writeInt32(s, 3, exitCode);
        writeStringAlways(s, 5, stdout);
        writeString(s, 6, stderr);
      }),
    );
  });
}

function shellFailureText(command: string, cwd: string, exitCode: number, stdout: string, stderr: string): Uint8Array {
  return encodeFields((w) => {
    writeBytesAlways(
      w,
      2,
      encodeFields((s) => {
        writeString(s, 1, command);
        writeString(s, 2, cwd);
        writeInt32(s, 3, exitCode);
        writeString(s, 5, stdout);
        writeString(s, 6, stderr);
      }),
    );
  });
}

function shellStreamEvent(oneofField: number, data: string): Uint8Array {
  return encodeFields((w) => {
    writeBytesAlways(
      w,
      oneofField,
      encodeFields((s) => writeStringAlways(s, 1, data)),
    );
  });
}

function shellStreamExit(code: number, cwd: string): Uint8Array {
  return encodeFields((w) => {
    writeBytesAlways(
      w,
      3,
      encodeFields((s) => {
        writeInt32(s, 1, code);
        writeString(s, 2, cwd);
      }),
    );
  });
}

function grepSuccess(
  pattern: string,
  pathArg: string,
  mode: string,
  union: { files?: string[]; count?: number; matches?: { file: string; lineNumber: number; content: string }[] },
): Uint8Array {
  const unionBytes = encodeFields((u) => {
    if (union.files) {
      const files = union.files;
      writeBytesAlways(
        u,
        2,
        encodeFields((f) => {
          for (const file of files) writeString(f, 1, file);
          writeUint32(f, 2, files.length);
        }),
      );
    } else if (union.matches) {
      writeBytesAlways(
        u,
        3,
        encodeFields((c) => {
          const byFile = new Map<string, { lineNumber: number; content: string }[]>();
          for (const m of union.matches ?? []) {
            const list = byFile.get(m.file) ?? [];
            list.push({ lineNumber: m.lineNumber, content: m.content });
            byFile.set(m.file, list);
          }
          let total = 0;
          for (const [file, matches] of byFile) {
            total += matches.length;
            writeBytesAlways(
              c,
              1,
              encodeFields((fm) => {
                writeString(fm, 1, file);
                for (const m of matches) {
                  writeBytesAlways(
                    fm,
                    2,
                    encodeFields((mm) => {
                      writeUint32(mm, 1, m.lineNumber);
                      writeStringAlways(mm, 2, m.content);
                    }),
                  );
                }
              }),
            );
          }
          writeUint32(c, 3, total);
        }),
      );
    } else {
      writeUint32(u, 1, union.count ?? 0);
    }
  });
  return encodeFields((w) => {
    writeBytesAlways(
      w,
      1,
      encodeFields((s) => {
        writeString(s, 1, pattern);
        writeString(s, 2, pathArg);
        writeString(s, 3, mode);
        writeBytesAlways(
          s,
          4,
          encodeFields((e) => {
            writeString(e, 1, "file://workspace");
            writeBytesAlways(e, 2, unionBytes);
          }),
        );
      }),
    );
  });
}

function grepError(error: string): Uint8Array {
  return encodeFields((w) => {
    writeBytesAlways(w, 2, encodeFields((e) => writeString(e, 1, error)));
  });
}

function readSuccess(pathArg: string, content: string, totalLines: number, truncated: boolean): Uint8Array {
  return encodeFields((w) => {
    writeBytesAlways(
      w,
      1,
      encodeFields((s) => {
        writeString(s, 1, pathArg);
        writeStringAlways(s, 2, content);
        writeInt32(s, 3, totalLines);
        writeInt32(s, 4, content.length);
        if (truncated) writeBool(s, 6, true);
      }),
    );
  });
}

function readError(pathArg: string, error: string): Uint8Array {
  return encodeFields((w) => {
    writeBytesAlways(
      w,
      2,
      encodeFields((e) => {
        writeString(e, 1, pathArg);
        writeString(e, 2, error);
      }),
    );
  });
}

function writeSuccess(pathArg: string, contents: string): Uint8Array {
  return encodeFields((w) => {
    writeBytesAlways(
      w,
      1,
      encodeFields((s) => {
        writeString(s, 1, pathArg);
        writeInt32(s, 2, contents === "" ? 0 : contents.split("\n").length);
        writeInt32(s, 3, contents.length);
      }),
    );
  });
}

function writeError(pathArg: string, error: string): Uint8Array {
  return encodeFields((w) => {
    writeBytesAlways(
      w,
      5,
      encodeFields((e) => {
        writeString(e, 1, pathArg);
        writeString(e, 2, error);
      }),
    );
  });
}

function deleteSuccess(pathArg: string, fileSize: number): Uint8Array {
  // DeleteSuccess: path=1, deleted_file=2 (STRING — the path again, not a bool),
  // file_size=3, prev_content=4.
  return encodeFields((w) => {
    writeBytesAlways(
      w,
      1,
      encodeFields((s) => {
        writeString(s, 1, pathArg);
        writeString(s, 2, pathArg);
        writeInt32(s, 3, fileSize);
      }),
    );
  });
}

function deleteError(pathArg: string, error: string): Uint8Array {
  return encodeFields((w) => {
    writeBytesAlways(
      w,
      7,
      encodeFields((e) => {
        writeString(e, 1, pathArg);
        writeString(e, 2, error);
      }),
    );
  });
}

// ---------------------------------------------------------------------------
// pi mode: translate to a Pi tool call; encode the Pi result back.
// ---------------------------------------------------------------------------

/** Set `out[key]` to `value` for the first candidate key the tool schema declares. */
function putIf(out: Record<string, unknown>, keys: string[], candidates: string[], value: unknown): boolean {
  for (const candidate of candidates) {
    const hit = keys.find((k) => k.toLowerCase() === candidate.toLowerCase());
    if (hit) {
      out[hit] = value;
      return true;
    }
  }
  return false;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Pick the Pi tool that can serve this native exec (capability match, never a
 * hardcoded name) and adapt the arguments to that tool's own JSON schema.
 * Null = no capable tool registered → the caller falls back to the reject path.
 */
export function translateNativeToPi(
  args: NativeArgs,
  tools: IrTool[],
): { tool: IrTool; args: Record<string, unknown> } | null {
  switch (args.case) {
    case "shellArgs":
    case "shellStreamArgs": {
      const tool = matchToolFor(args.case, tools);
      if (!tool) return null;
      const keys = schemaProperties(tool);
      const out: Record<string, unknown> = {};
      if (!putIf(out, keys, ["command", "cmd", "script", "shell"], args.command)) return null;
      // args.timeoutMs is deliberately NOT translated: the wire field's unit is
      // unverified (PROTOCOL-AGENT §5.1), a wrong unit is worse than Pi's default.
      if (args.workingDirectory !== "") {
        putIf(out, keys, ["cwd", "workingDirectory", "working_directory", "workdir"], args.workingDirectory);
      }
      return { tool, args: out };
    }
    case "readArgs": {
      const tool = matchToolFor("readArgs", tools);
      if (!tool) return null;
      const keys = schemaProperties(tool);
      const out: Record<string, unknown> = {};
      if (!putIf(out, keys, ["path", "file_path", "filePath", "file"], args.path)) return null;
      return { tool, args: out };
    }
    case "writeArgs": {
      const tool = matchToolFor("writeArgs", tools);
      if (!tool) return null;
      const keys = schemaProperties(tool);
      const out: Record<string, unknown> = {};
      if (!putIf(out, keys, ["path", "file_path", "filePath", "file"], args.path)) return null;
      if (!putIf(out, keys, ["content", "contents", "text"], args.contents)) return null;
      return { tool, args: out };
    }
    case "deleteArgs": {
      // No Pi tool set ships a delete tool; route through the command tool so
      // the delete still passes Pi's permission system. Live-verified: a
      // DeleteSuccess with file_size omitted (=0) makes the backend journal the
      // result and then stall the turn forever; reporting the REAL pre-delete
      // size completes the turn. So the composite command captures the size
      // before rm and prints it behind a D0: marker for the result encoder.
      const tool = matchToolFor("deleteArgs", tools);
      if (!tool) return null;
      const keys = schemaProperties(tool);
      const q = shellQuote(args.path);
      const command = `sz=$(wc -c < ${q}) && rm -- ${q} && printf 'D0:%s\\n' "$sz"`;
      const out: Record<string, unknown> = {};
      if (!putIf(out, keys, ["command", "cmd", "script", "shell"], command)) return null;
      return { tool, args: out };
    }
    case "grepArgs": {
      if (args.pattern === "" && args.glob !== "") {
        // Cursor's "Glob" (PROTOCOL-AGENT §5.1): prefer a find/glob-capable tool.
        const tool = matchToolFor("lsArgs", tools);
        if (!tool) return null;
        const keys = schemaProperties(tool);
        const out: Record<string, unknown> = {};
        if (!putIf(out, keys, ["pattern", "glob", "query"], args.glob)) return null;
        if (args.path !== "") putIf(out, keys, ["path", "dir", "root"], args.path);
        return { tool, args: out };
      }
      const tool = matchToolFor("grepArgs", tools);
      if (!tool) return null;
      const keys = schemaProperties(tool);
      const out: Record<string, unknown> = {};
      if (!putIf(out, keys, ["pattern", "query", "regex"], args.pattern)) return null;
      if (args.path !== "") putIf(out, keys, ["path", "dir", "root"], args.path);
      if (args.glob !== "") putIf(out, keys, ["glob", "include"], args.glob);
      if (args.caseInsensitive) {
        putIf(out, keys, ["caseInsensitive", "case_insensitive", "ignoreCase", "ignore_case"], true);
      }
      return { tool, args: out };
    }
    default:
      return null;
  }
}

/** Best-effort parse of grep-style "file:line:content" tool output. */
function parseGrepContent(text: string): { file: string; lineNumber: number; content: string }[] {
  const out: { file: string; lineNumber: number; content: string }[] = [];
  for (const line of text.split("\n")) {
    const m = /^(.+?):(\d+)[:\-](.*)$/.exec(line);
    if (m) out.push({ file: m[1] ?? "", lineNumber: Number(m[2]), content: m[3] ?? "" });
  }
  return out;
}

/**
 * Encode a Pi tool result into the native exec success/error wire shape.
 * Failure is reported on the native error arm so the model sees a real tool
 * outcome, not a provider refusal.
 */
export function encodeNativeResultFromPi(args: NativeArgs, text: string, isError: boolean): NativeReply {
  switch (args.case) {
    case "shellArgs":
      return {
        frames: [
          {
            resultField: 2,
            resultBytes: isError
              ? shellFailureText(args.command, args.workingDirectory, 1, "", text)
              : shellSuccess(args.command, args.workingDirectory, 0, text, ""),
          },
        ],
        closeStream: true,
        summary: `pi shell ${args.command.slice(0, 60)}`,
      };
    case "shellStreamArgs": {
      const frames: NativeReplyFrame[] = [];
      if (text !== "") frames.push({ resultField: 14, resultBytes: shellStreamEvent(isError ? 2 : 1, text) });
      frames.push({ resultField: 14, resultBytes: shellStreamExit(isError ? 1 : 0, args.workingDirectory) });
      return { frames, closeStream: true, summary: `pi shellStream ${args.command.slice(0, 60)}` };
    }
    case "readArgs": {
      if (isError) {
        return { frames: [{ resultField: 7, resultBytes: readError(args.path, text) }], closeStream: true, summary: `pi read error` };
      }
      const truncated = /\[.*truncat|\[Showing (lines|last)/i.test(text);
      return {
        frames: [{ resultField: 7, resultBytes: readSuccess(args.path, text, text.split("\n").length, truncated) }],
        closeStream: true,
        summary: `pi read ${args.path}`,
      };
    }
    case "writeArgs":
      return {
        frames: [
          {
            resultField: 3,
            resultBytes: isError ? writeError(args.path, text) : writeSuccess(args.path, args.contents),
          },
        ],
        closeStream: true,
        summary: `pi write ${args.path}`,
      };
    case "deleteArgs": {
      if (isError) {
        return {
          frames: [{ resultField: 4, resultBytes: deleteError(args.path, text) }],
          closeStream: true,
          summary: `pi delete error`,
        };
      }
      // The composite command reports the pre-delete size as "D0:<n>". Without a
      // real size the backend stalls the turn, so an unparseable output is an
      // error, not a size-0 success.
      const m = /D0:\s*(\d+)/.exec(text);
      return {
        frames: [
          {
            resultField: 4,
            resultBytes: m ? deleteSuccess(args.path, Number(m[1])) : deleteError(args.path, text),
          },
        ],
        closeStream: true,
        summary: `pi delete ${args.path}`,
      };
    }
    case "grepArgs": {
      if (isError) {
        return { frames: [{ resultField: 5, resultBytes: grepError(text) }], closeStream: true, summary: `pi grep error` };
      }
      const mode = args.outputMode;
      const union =
        mode === "files_with_matches"
          ? { files: text.split("\n").filter((l) => l.trim() !== "") }
          : mode === "count"
            ? (() => {
                // "file:N" lines when the tool reports per-file counts; else a total.
                let total = 0;
                let parsed = false;
                for (const line of text.split("\n")) {
                  const m = /:(\d+)\s*$/.exec(line);
                  if (m) {
                    total += Number(m[1]);
                    parsed = true;
                  }
                }
                return { count: parsed ? total : text.trim() === "" ? 0 : text.split("\n").length };
              })()
            : (() => {
                const matches = parseGrepContent(text);
                return {
                  matches: matches.length > 0 ? matches : text.trim() === "" ? [] : [{ file: "", lineNumber: 0, content: text }],
                };
              })();
      return {
        frames: [{ resultField: 5, resultBytes: grepSuccess(args.pattern, args.path, mode, union) }],
        closeStream: true,
        summary: `pi grep ${args.pattern || args.glob}`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// inproc mode: probe-grade executors. tools/probe-native.ts only; never run in
// a real session (mode "pi" is the session path).
// ---------------------------------------------------------------------------

function execInproc(command: string, cwd: string, timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("sh", ["-c", command], { cwd: cwd === "" ? undefined : cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
    }, timeoutMs > 0 ? timeoutMs : 30_000);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: stderr + String(err) });
    });
  });
}

/** Probe executor. Real sessions must use mode "pi" (Pi executes, we translate). */
async function executeNativeInproc(args: NativeArgs): Promise<NativeReply> {
  switch (args.case) {
    case "shellArgs": {
      const r = await execInproc(args.command, args.workingDirectory, args.timeoutMs);
      return {
        frames: [
          { resultField: 2, resultBytes: shellSuccess(args.command, args.workingDirectory, r.code, r.stdout, r.stderr) },
        ],
        closeStream: true,
        summary: `shell ${args.command.slice(0, 60)}`,
      };
    }
    case "shellStreamArgs": {
      const r = await execInproc(args.command, args.workingDirectory, args.timeoutMs);
      const frames: NativeReplyFrame[] = [];
      if (r.stdout !== "") frames.push({ resultField: 14, resultBytes: shellStreamEvent(1, r.stdout) });
      if (r.stderr !== "") frames.push({ resultField: 14, resultBytes: shellStreamEvent(2, r.stderr) });
      frames.push({ resultField: 14, resultBytes: shellStreamExit(r.code, args.workingDirectory) });
      return { frames, closeStream: true, summary: `shellStream ${args.command.slice(0, 60)}` };
    }
    case "readArgs": {
      const target = path.resolve(args.path);
      try {
        const raw = fs.readFileSync(target, "utf8");
        const totalLines = raw.split("\n").length;
        return {
          frames: [{ resultField: 7, resultBytes: readSuccess(target, raw, totalLines, false) }],
          closeStream: true,
          summary: `read ${target} (${String(totalLines)} lines)`,
        };
      } catch (err) {
        return {
          frames: [{ resultField: 7, resultBytes: readError(target, String(err)) }],
          closeStream: true,
          summary: `read error ${target}`,
        };
      }
    }
    case "writeArgs": {
      const target = path.resolve(args.path);
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, args.contents);
        return {
          frames: [{ resultField: 3, resultBytes: writeSuccess(target, args.contents) }],
          closeStream: true,
          summary: `write ${target} (${String(args.contents.length)} bytes)`,
        };
      } catch (err) {
        return {
          frames: [{ resultField: 3, resultBytes: writeError(target, String(err)) }],
          closeStream: true,
          summary: `write error ${target}`,
        };
      }
    }
    case "deleteArgs": {
      const target = path.resolve(args.path);
      try {
        const size = fs.statSync(target).size;
        fs.rmSync(target);
        return {
          frames: [{ resultField: 4, resultBytes: deleteSuccess(target, size) }],
          closeStream: true,
          summary: `delete ${target}`,
        };
      } catch (err) {
        return {
          frames: [{ resultField: 4, resultBytes: deleteError(target, String(err)) }],
          closeStream: true,
          summary: `delete error ${target}`,
        };
      }
    }
    case "grepArgs": {
      const root = args.path === "" ? process.cwd() : path.resolve(args.path);
      const globToFind = (glob: string): string => {
        const segs = glob.split("/").filter((s) => s !== "" && s !== "." && s !== "**");
        return segs.length === 0 ? "*" : (segs[segs.length - 1] ?? "*");
      };
      const icase = args.caseInsensitive ? "-i " : "";
      let command: string;
      if (args.pattern === "" && args.glob !== "") {
        command = `find ${shellQuote(root)} -name ${shellQuote(globToFind(args.glob))} -type f 2>&1 | head -100`;
      } else if (args.outputMode === "files_with_matches") {
        const globFilter = args.glob !== "" ? `--include=${shellQuote(globToFind(args.glob))} ` : "";
        command = `grep -rIl${args.caseInsensitive ? "i" : ""} ${globFilter}-- ${shellQuote(args.pattern)} ${shellQuote(root)} 2>&1 | head -100`;
      } else if (args.outputMode === "count") {
        const globFilter = args.glob !== "" ? `--include=${shellQuote(globToFind(args.glob))} ` : "";
        command = `grep -rIc ${icase}${globFilter}-- ${shellQuote(args.pattern)} ${shellQuote(root)} 2>&1 | grep -v ':0$' | head -100`;
      } else {
        const globFilter = args.glob !== "" ? `--include=${shellQuote(globToFind(args.glob))} ` : "";
        command = `grep -rIn ${icase}${globFilter}-- ${shellQuote(args.pattern)} ${shellQuote(root)} 2>&1 | head -200`;
      }
      const r = await execInproc(command, "", 15_000);
      const out = r.stdout.trimEnd();
      if (r.code > 1 && r.stdout === "") {
        return { frames: [{ resultField: 5, resultBytes: grepError(r.stderr || out) }], closeStream: true, summary: "grep error" };
      }
      const mode = args.outputMode;
      const union =
        args.pattern === "" || mode === "files_with_matches"
          ? { files: out === "" ? [] : out.split("\n") }
          : mode === "count"
            ? {
                count:
                  out === ""
                    ? 0
                    : out
                        .split("\n")
                        .map((l) => Number(l.split(":").pop() ?? "0"))
                        .reduce((a, b) => a + b, 0),
              }
            : { matches: parseGrepContent(out) };
      return {
        frames: [{ resultField: 5, resultBytes: grepSuccess(args.pattern, root, mode, union) }],
        closeStream: true,
        summary: `grep ${args.pattern} ${args.glob} (${mode})`,
      };
    }
  }
}

/** inproc entry point used by session.ts when the mode is "inproc". */
export async function tryNativeExecInproc(exec: DecodedExec): Promise<NativeReply | null> {
  const args = decodeNativeArgs(exec);
  if (!args) return null;
  debugLog({
    event: "agent-native-args",
    case: exec.case,
    payloadHex: Buffer.from(exec.payload).toString("hex").slice(0, 400),
  });
  return executeNativeInproc(args);
}

export function logNativeExec(execCase: string, execId: string, reply: NativeReply): void {
  debugLog({
    event: "agent-native-exec",
    case: execCase,
    execId,
    summary: reply.summary,
    frames: reply.frames.length,
    closeStream: reply.closeStream,
  });
}
