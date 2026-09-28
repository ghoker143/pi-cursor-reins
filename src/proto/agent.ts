// SPDX-License-Identifier: AGPL-3.0-or-later
/** Minimal agent.v1 surface. Field numbers: PROTOCOL-AGENT.md. */

import { driftError } from "../errors.ts";
import { jsonToValueBytes, valueBytesToJson } from "./struct.ts";
import {
  BinaryReader,
  encodeFields,
  expectBytes,
  expectString,
  expectVarint,
    skipUnknown,
    writeBool,
    writeBytes,
    writeBytesAlways,
    writeInt32,
  writeString,
  writeStringAlways,
    writeUint32Always,
  forEachField,
  WireType,
} from "./wire.ts";

export const EXEC_CASES = [
  "shellArgs",
  "writeArgs",
  "deleteArgs",
  "grepArgs",
  "readArgs",
  "lsArgs",
  "diagnosticsArgs",
  "requestContextArgs",
  "mcpArgs",
  "shellStreamArgs",
  "backgroundShellSpawnArgs",
  "listMcpResourcesExecArgs",
  "readMcpResourceExecArgs",
  "fetchArgs",
  "recordScreenArgs",
  "computerUseArgs",
  "writeShellStdinArgs",
  "reflectArgs",
  "setupVmEnvironmentArgs",
  "truncatedToolCallArgs",
  "startGrindExecutionArgs",
  "startGrindPlanningArgs",
] as const;

export type ExecCase = (typeof EXEC_CASES)[number];

export const EXEC_FIELD: Record<ExecCase, number> = {
  shellArgs: 2,
  writeArgs: 3,
  deleteArgs: 4,
  grepArgs: 5,
  readArgs: 7,
  lsArgs: 8,
  diagnosticsArgs: 9,
  requestContextArgs: 10,
  mcpArgs: 11,
  shellStreamArgs: 14,
  backgroundShellSpawnArgs: 16,
  listMcpResourcesExecArgs: 17,
  readMcpResourceExecArgs: 18,
  fetchArgs: 20,
  recordScreenArgs: 21,
  computerUseArgs: 22,
  writeShellStdinArgs: 23,
  reflectArgs: 32,
  setupVmEnvironmentArgs: 33,
  truncatedToolCallArgs: 34,
  startGrindExecutionArgs: 35,
  startGrindPlanningArgs: 36,
};

const FIELD_TO_EXEC = new Map<number, ExecCase>(
  (Object.entries(EXEC_FIELD) as [ExecCase, number][]).map(([k, v]) => [v, k]),
);

export interface McpCall {
  name: string;
  toolName: string;
  toolCallId: string;
  providerIdentifier: string;
  args: Record<string, unknown>;
}

export interface ExecStrings {
  command?: string;
  path?: string;
  workingDirectory?: string;
  url?: string;
  uri?: string;
}

export interface DecodedExec {
  id: number;
  execId: string;
  field: number;
  case: ExecCase | "unknown";
  mcp?: McpCall;
  strings: ExecStrings;
  /**
   * First length-delimited field we could not classify. Cursor adds native exec
   * cases over time; keeping the raw arm lets a drift report name the new field
   * instead of only saying "unknown".
   */
  unknown?: { field: number; bytes: Uint8Array };
}

export interface DecodedKv {
  id: number;
  case: "getBlobArgs" | "setBlobArgs" | "unknown";
  blobId?: Uint8Array;
  blobData?: Uint8Array;
}

export interface DecodedQuery {
  id: number;
  field: number;
  case:
    | "webSearch"
    | "askQuestion"
    | "switchMode"
    | "exaSearch"
    | "exaFetch"
    | "createPlan"
    | "setupVm"
    | "hostedWebFetch"
    | "unknown";
}

export type InteractionInner =
  | { case: "textDelta"; text: string }
  | { case: "thinkingDelta"; text: string }
  | { case: "tokenDelta"; tokens: number }
  | { case: "heartbeat" }
  | { case: "turnEnded" }
  | { case: "other"; field: number };

export type AgentServerMessage =
  | { case: "interactionUpdate"; inner: InteractionInner }
  | { case: "execServerMessage"; exec: DecodedExec }
  | { case: "checkpoint"; bytes: Uint8Array }
  | { case: "kvServerMessage"; kv: DecodedKv }
  | { case: "execServerControl"; field: number }
  | { case: "interactionQuery"; query: DecodedQuery }
  | { case: "ttft" }
  | { case: "unknown"; field: number };

function decodeExecStrings(bytes: Uint8Array): ExecStrings {
  const s: ExecStrings = {};
  forEachField(bytes, (field, wire, reader) => {
    if (wire !== WireType.LengthDelimited) {
      skipUnknown(reader, wire, field);
      return;
    }
    const text = expectString(reader, wire);
    if (field === 1) {
      if (text.startsWith("http://") || text.startsWith("https://")) s.url = text;
      else if (text.includes("/") || text.includes("\\") || text.startsWith(".")) s.path = text;
      else s.command = text;
      if (s.path === undefined && s.command === undefined) s.command = text;
      if (!s.path) s.path = text;
    } else if (field === 2) {
      s.workingDirectory = text;
      s.uri = text;
    }
    // ignore remaining
  });
  return s;
}

function decodeMcp(bytes: Uint8Array): McpCall {
  let name = "";
  let toolName = "";
  let toolCallId = "";
  let providerIdentifier = "";
  let args: Record<string, unknown> = {};
  const argEntries: Record<string, Uint8Array> = {};
  forEachField(bytes, (field, wire, reader) => {
    if (field === 1) name = expectString(reader, wire);
    else if (field === 2) {
      const entry = expectBytes(reader, wire);
      let key = "";
      let value: Uint8Array = new Uint8Array();
      forEachField(entry, (f, w, r) => {
        if (f === 1) key = expectString(r, w);
        else if (f === 2) value = new Uint8Array(expectBytes(r, w));
        else skipUnknown(r, w, f);
      });
      if (key !== "") argEntries[key] = value;
    } else if (field === 3) toolCallId = expectString(reader, wire);
    else if (field === 4) providerIdentifier = expectString(reader, wire);
    else if (field === 5) toolName = expectString(reader, wire);
    else skipUnknown(reader, wire, field);
  });
  for (const [k, v] of Object.entries(argEntries)) {
    try {
      args[k] = valueBytesToJson(v);
    } catch {
      args[k] = new TextDecoder().decode(v);
    }
  }
  return { name, toolName: toolName || name, toolCallId, providerIdentifier, args };
}

function decodeExec(bytes: Uint8Array): DecodedExec {
  let id = 0;
  let execId = "";
  let field = 0;
  let payload = new Uint8Array();
  let unknown: { field: number; bytes: Uint8Array } | undefined;
  forEachField(bytes, (f, wire, reader) => {
    if (f === 1) id = expectVarint(reader, wire);
    else if (f === 15) execId = expectString(reader, wire);
    else if (FIELD_TO_EXEC.has(f) && wire === WireType.LengthDelimited && field === 0) {
      field = f;
      payload = new Uint8Array(expectBytes(reader, wire));
    } else {
      if (unknown === undefined && wire === WireType.LengthDelimited && field === 0) {
        unknown = { field: f, bytes: new Uint8Array(expectBytes(reader, wire)) };
        return;
      }
      skipUnknown(reader, wire, f);
    }
  });
  const execCase = FIELD_TO_EXEC.get(field) ?? "unknown";
  return {
    id,
    execId,
    field,
    case: execCase,
    mcp: execCase === "mcpArgs" ? decodeMcp(payload) : undefined,
    strings: decodeExecStrings(payload),
    ...(unknown ? { unknown } : {}),
  };
}

function decodeKv(bytes: Uint8Array): DecodedKv {
  let id = 0;
  let kvCase: DecodedKv["case"] = "unknown";
  let blobId: Uint8Array | undefined;
  let blobData: Uint8Array | undefined;
  forEachField(bytes, (field, wire, reader) => {
    if (field === 1) id = expectVarint(reader, wire);
    else if (field === 2 || field === 3) {
      const inner = expectBytes(reader, wire);
      kvCase = field === 2 ? "getBlobArgs" : "setBlobArgs";
      forEachField(inner, (f, w, r) => {
        if (f === 1) blobId = new Uint8Array(expectBytes(r, w));
        else if (f === 2) blobData = new Uint8Array(expectBytes(r, w));
        else skipUnknown(r, w, f);
      });
    } else skipUnknown(reader, wire, field);
  });
  return { id, case: kvCase, blobId, blobData };
}

function decodeQuery(bytes: Uint8Array): DecodedQuery {
  let id = 0;
  let field = 0;
  forEachField(bytes, (f, wire, reader) => {
    if (f === 1) id = expectVarint(reader, wire);
    else if (wire === WireType.LengthDelimited && field === 0) {
      field = f;
      skipUnknown(reader, wire, f);
    } else skipUnknown(reader, wire, f);
  });
  const cases: DecodedQuery["case"][] = [
    "unknown",
    "unknown",
    "webSearch",
    "askQuestion",
    "switchMode",
    "exaSearch",
    "exaFetch",
    "createPlan",
    "setupVm",
    "hostedWebFetch",
  ];
  return { id, field, case: cases[field] ?? "unknown" };
}

function decodeUpdateArm(field: number, payload: Uint8Array): InteractionInner | undefined {
  if (field === 1) {
    let text = "";
    forEachField(payload, (f, w, r) => {
      if (f === 1) text = expectString(r, w);
      else skipUnknown(r, w, f);
    });
    return { case: "textDelta", text };
  }
  if (field === 4) {
    let text = "";
    forEachField(payload, (f, w, r) => {
      if (f === 1) text = expectString(r, w);
      else skipUnknown(r, w, f);
    });
    return { case: "thinkingDelta", text };
  }
  if (field === 8) {
    let tokens = 0;
    forEachField(payload, (f, w, r) => {
      if (f === 1) tokens = expectVarint(r, w);
      else skipUnknown(r, w, f);
    });
    return { case: "tokenDelta", tokens };
  }
  if (field === 13) return { case: "heartbeat" };
  if (field === 14) return { case: "turnEnded" };
  return undefined;
}

function decodeUpdate(bytes: Uint8Array): InteractionInner {
  let inner: InteractionInner | undefined;
  forEachField(bytes, (field, wire, reader) => {
    if (field === 25) {
      skipUnknown(reader, wire, field);
      return;
    }
    if (wire !== WireType.LengthDelimited) {
      skipUnknown(reader, wire, field);
      return;
    }
    const payload = expectBytes(reader, wire);
    const decoded = decodeUpdateArm(field, payload);
    if (decoded === undefined) {
      // Unknown arm: remember the first for drift reporting, but never let it
      // clobber an already-decoded delta (Cursor adds fields over time).
      if (inner === undefined) inner = { case: "other", field };
      return;
    }
    if (inner !== undefined && inner.case !== "other") {
      throw driftError(`Cursor InteractionUpdate carried a second known arm (field ${String(field)})`);
    }
    inner = decoded;
  });
  return inner ?? { case: "other", field: 0 };
}

export function decodeAgentServerMessage(bytes: Uint8Array): AgentServerMessage {
  let msg: AgentServerMessage | undefined;
  forEachField(bytes, (field, wire, reader) => {
    if (field === 8) {
      skipUnknown(reader, wire, field);
      return;
    }
    if (wire !== WireType.LengthDelimited) {
      skipUnknown(reader, wire, field);
      return;
    }
    const payload = expectBytes(reader, wire);
    if (msg !== undefined) return;
    if (field === 1) msg = { case: "interactionUpdate", inner: decodeUpdate(payload) };
    else if (field === 2) msg = { case: "execServerMessage", exec: decodeExec(payload) };
    else if (field === 3) msg = { case: "checkpoint", bytes: payload };
    else if (field === 4) msg = { case: "kvServerMessage", kv: decodeKv(payload) };
    else if (field === 5) msg = { case: "execServerControl", field: 0 };
    else if (field === 7) msg = { case: "interactionQuery", query: decodeQuery(payload) };
    else msg = { case: "unknown", field };
  });
  return msg ?? { case: "unknown", field: 0 };
}

export interface McpToolWire {
  name: string;
  description: string;
  jsonSchema: Record<string, unknown>;
}

export function encodeMcpTools(tools: McpToolWire[]): Uint8Array {
  return encodeFields((w) => {
    for (const tool of tools) {
      writeBytes(
        w,
        1,
        encodeFields((tw) => {
          writeString(tw, 1, tool.name);
          writeString(tw, 2, tool.description);
          writeBytes(tw, 3, jsonToValueBytes(tool.jsonSchema));
          writeString(tw, 4, "pi");
          writeString(tw, 5, tool.name);
        }),
      );
    }
  });
}

export function encodeRequestedModel(
  modelId: string,
  maxMode: boolean,
  contextParam?: string,
  effortParams?: { id: string; value: string }[],
): Uint8Array {
  return encodeFields((w) => {
    writeString(w, 1, modelId);
    writeBool(w, 2, maxMode);
    if (contextParam) {
      writeBytes(
        w,
        3,
        encodeFields((pw) => {
          writeString(pw, 1, "context");
          writeString(pw, 2, contextParam);
        }),
      );
    }
    // Effort/thinking knobs are variant parameters; the id is per model family
    // (`reasoning_effort` / `reasoning` / `effort`). PROTOCOL-AGENT §2.1.
    for (const param of effortParams ?? []) {
      writeBytes(
        w,
        3,
        encodeFields((pw) => {
          writeString(pw, 1, param.id);
          writeString(pw, 2, param.value);
        }),
      );
    }
  });
}

export interface WireImage {
  uuid: string;
  path: string;
  mimeType: string;
  data: Uint8Array;
}

/** SelectedImage: uuid=2, path=3, mime_type=7, data=8 (raw bytes). PROTOCOL-AGENT §2.1 */
export function encodeSelectedImage(image: WireImage): Uint8Array {
  return encodeFields((w) => {
    writeString(w, 2, image.uuid);
    writeString(w, 3, image.path);
    writeString(w, 7, image.mimeType);
    writeBytesAlways(w, 8, image.data);
  });
}

/** SelectedContext.selected_images = field 1. */
export function encodeSelectedContext(images: WireImage[]): Uint8Array {
  return encodeFields((w) => {
    for (const image of images) writeBytes(w, 1, encodeSelectedImage(image));
  });
}

export function encodeUserMessage(opts: {
  text: string;
  messageId: string;
  selectedContextBlob: Uint8Array;
  images?: WireImage[];
}): Uint8Array {
  return encodeFields((w) => {
    writeString(w, 1, opts.text);
    writeString(w, 2, opts.messageId);
    if (opts.images && opts.images.length > 0) writeBytes(w, 3, encodeSelectedContext(opts.images));
    writeInt32(w, 4, 1);
    writeBytes(w, 10, opts.selectedContextBlob);
    writeString(w, 17, opts.messageId);
  });
}

export function encodeConversationState(opts: {
  rootPromptBlobIds: Uint8Array[];
  workspaceUri: string;
}): Uint8Array {
  return encodeFields((w) => {
    for (const id of opts.rootPromptBlobIds) writeBytes(w, 1, id);
    writeString(w, 9, opts.workspaceUri);
    writeInt32(w, 10, 1);
    writeString(w, 22, "pi");
  });
}

/**
 * Resume: keep Cursor's journal (turns, todos, summaries, file state, **and**
 * the checkpoint's root_prompt). Only workspace / client_name are replaced.
 * Current rules are appended as extra field-1 blobs (not a Pi history replay).
 */
export function overlayCheckpointState(
  checkpoint: Uint8Array,
  opts: { rootPromptBlobIds: Uint8Array[]; workspaceUri: string },
): Uint8Array {
  const overlay = encodeConversationState(opts);
  const kept = encodeFields((w) => {
    const reader = new BinaryReader(checkpoint);
    while (reader.pos < reader.len) {
      const start = reader.pos;
      const [field, wire] = reader.tag();
      skipUnknown(reader, wire, field);
      if (field === 9 || field === 22) continue;
      w.raw(checkpoint.subarray(start, reader.pos));
    }
  });
  const out = new Uint8Array(overlay.byteLength + kept.byteLength);
  out.set(overlay, 0);
  out.set(kept, overlay.byteLength);
  return out;
}

export function encodeSelectedContextBlob(rootPromptBlobIds: Uint8Array[], clientName = "pi"): Uint8Array {
  return encodeFields((w) => {
    for (const id of rootPromptBlobIds) writeBytes(w, 1, id);
    writeString(w, 22, clientName);
  });
}

export function encodeRunRequest(opts: {
  conversationState: Uint8Array;
  userMessage: Uint8Array;
  requestedModel: Uint8Array;
  mcpTools: Uint8Array;
  conversationId: string;
}): Uint8Array {
  const action = encodeFields((w) => {
    writeBytes(
      w,
      1,
      encodeFields((uw) => {
        writeBytes(uw, 1, opts.userMessage);
      }),
    );
  });
  const run = encodeFields((w) => {
    writeBytes(w, 1, opts.conversationState);
    writeBytes(w, 2, action);
    writeBytes(w, 4, opts.mcpTools);
    writeString(w, 5, opts.conversationId);
    writeBytes(w, 9, opts.requestedModel);
    // client_supports_inline_images — required for SelectedImage.data and McpImageContent.
    writeBool(w, 19, true);
  });
  return encodeFields((w) => writeBytes(w, 1, run));
}

export function encodeExecClientMessage(opts: {
  id: number;
  execId: string;
  resultField: number;
  resultBytes: Uint8Array;
}): Uint8Array {
  const exec = encodeFields((w) => {
    writeUint32Always(w, 1, opts.id);
    writeString(w, 15, opts.execId);
    writeBytesAlways(w, opts.resultField, opts.resultBytes);
  });
  return encodeFields((w) => writeBytes(w, 2, exec));
}

export function encodeExecThrow(id: number, error: string): Uint8Array {
  const control = encodeFields((w) => {
    writeBytesAlways(
      w,
      2,
      encodeFields((tw) => {
        writeUint32Always(tw, 1, id);
        writeString(tw, 2, error);
      }),
    );
  });
  return encodeFields((w) => writeBytes(w, 5, control));
}

export function encodeKvGetResult(id: number, blobData: Uint8Array): Uint8Array {
  const kv = encodeFields((w) => {
    writeUint32Always(w, 1, id);
    writeBytes(
      w,
      2,
      encodeFields((gw) => {
        writeBytesAlways(gw, 1, blobData);
      }),
    );
  });
  return encodeFields((w) => writeBytes(w, 3, kv));
}

export function encodeKvSetResult(id: number): Uint8Array {
  const kv = encodeFields((w) => {
    writeUint32Always(w, 1, id);
    writeBytesAlways(w, 3, encodeFields(() => undefined));
  });
  return encodeFields((w) => writeBytes(w, 3, kv));
}

export function encodeClientHeartbeat(): Uint8Array {
  return encodeFields((w) => writeBytesAlways(w, 7, encodeFields(() => undefined)));
}

export function encodeInteractionResponse(id: number, resultField: number, resultBytes: Uint8Array): Uint8Array {
  const response = encodeFields((w) => {
    writeUint32Always(w, 1, id);
    writeBytesAlways(w, resultField, resultBytes);
  });
  return encodeFields((w) => writeBytes(w, 6, response));
}

export function encodeEmpty(): Uint8Array {
  return encodeFields(() => undefined);
}

export function encodeStringField(field: number, value: string): Uint8Array {
  return encodeFields((w) => writeString(w, field, value));
}

export function encodeNested(field: number, inner: Uint8Array): Uint8Array {
  return encodeFields((w) => writeBytesAlways(w, field, inner));
}

export function encodeMcpTextItem(text: string): Uint8Array {
  return encodeFields((w) => {
    writeBytesAlways(w, 1, encodeFields((tw) => writeStringAlways(tw, 1, text)));
  });
}

/** McpImageContent: data=1 (bytes), mime_type=2. PROTOCOL-AGENT §8 */
export function encodeMcpImageItem(image: { data: Uint8Array; mimeType: string }): Uint8Array {
  return encodeFields((w) => {
    writeBytes(
      w,
      2,
      encodeFields((iw) => {
        writeBytesAlways(iw, 1, image.data);
        writeString(iw, 2, image.mimeType);
      }),
    );
  });
}

export function encodeMcpSuccess(
  text: string,
  isError: boolean,
  images: { data: Uint8Array; mimeType: string }[] = [],
): Uint8Array {
  const success = encodeFields((w) => {
    writeBytesAlways(w, 1, encodeMcpTextItem(text));
    for (const image of images) writeBytesAlways(w, 1, encodeMcpImageItem(image));
    writeBool(w, 2, isError);
  });
  return encodeFields((w) => writeBytes(w, 1, success));
}

export function encodeMcpToolNotFound(name: string, available: string[]): Uint8Array {
  const notFound = encodeFields((w) => {
    writeString(w, 1, name);
    for (const tool of available) writeString(w, 2, tool);
  });
  return encodeFields((w) => writeBytes(w, 5, notFound));
}

export function encodeRequestContextSuccess(workspaceUri: string, tools: McpToolWire[]): Uint8Array {
  const env = encodeFields((w) => {
    writeString(w, 2, workspaceUri);
  });
  const ctx = encodeFields((w) => {
    writeBytes(w, 4, env);
    for (const tool of tools) {
      writeBytes(
        w,
        7,
        encodeFields((tw) => {
          writeString(tw, 1, tool.name);
          writeString(tw, 2, tool.description);
          writeBytes(tw, 3, jsonToValueBytes(tool.jsonSchema));
          writeString(tw, 4, "pi");
          writeString(tw, 5, tool.name);
        }),
      );
    }
  });
  const success = encodeFields((w) => writeBytes(w, 1, ctx));
  return encodeFields((w) => writeBytes(w, 1, success));
}
