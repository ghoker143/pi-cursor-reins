// SPDX-License-Identifier: AGPL-3.0-or-later
/** Minimal aiserver.v1 surface actually sent/parsed. Comments cite PROTOCOL.md. */

import { EXEC_DRIFT_MESSAGE, driftError } from "../errors.ts";
import { jsonToStructBytes, jsonToValueBytes, structBytesToJson, valueBytesToJson } from "./struct.ts";
import {
  encodeFields,
  expectBool,
  expectBytes,
  expectString,
  expectVarint,
  skipUnknown,
  writeBool,
  writeBytes,
  writeEnum,
  writeFloat,
  writeInt32,
  writeString,
  forEachField,
  WireType,
} from "./wire.ts";

export const InferenceMessageRole = {
  UNSPECIFIED: 0,
  USER: 1,
  ASSISTANT: 2,
  TOOL: 3,
  SYSTEM: 4,
} as const;

export const InferenceStreamErrorType = {
  UNSPECIFIED: 0,
  UNKNOWN: 1,
  INPUT_TOKEN_LIMIT: 2,
  OUTPUT_TOKEN_LIMIT: 3,
  RATE_LIMIT: 4,
  AUTHENTICATION: 5,
  PERMISSION: 6,
  OVERLOADED: 7,
  CONTENT_FILTER: 8,
} as const;

export const RoutingRole = {
  UNSPECIFIED: 0,
  USER: 1,
  ASSISTANT: 2,
} as const;

export type JsonObject = Record<string, unknown>;

export interface InferenceToolCall {
  toolCallId: string;
  toolName: string;
  args: JsonObject;
  rawToolCallArgs?: string;
}

export interface InferenceReasoningPart {
  isRedacted: boolean;
  text: string;
  signature?: string;
  redactedData?: string;
  modelName?: string;
}

export interface InferenceToolResultPart {
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
}

export interface InferenceCoreMessage {
  role: number;
  text?: string;
  toolCalls?: InferenceToolCall[];
  reasoningParts?: InferenceReasoningPart[];
  toolResults?: InferenceToolResultPart[];
  modelProviderMessageId?: string;
}

export interface InferenceAgentTool {
  name: string;
  description: string;
  jsonSchema: JsonObject;
}

export interface InferenceModelConfig {
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
}

export interface ModelParameter {
  id: string;
  value: string;
}

export interface InferenceRequestedModel {
  modelId: string;
  maxMode?: boolean;
  parameters?: ModelParameter[];
}

export interface InferenceStreamRequest {
  messages: InferenceCoreMessage[];
  tools: InferenceAgentTool[];
  modelConfig?: InferenceModelConfig;
  requestedModel?: InferenceRequestedModel;
  conversationId?: string;
  invocationId?: string;
}

export interface RoutingMessage {
  role: number;
  text: string;
}

export interface RunInferenceRunRequest {
  conversationId: string;
  requestedModel: InferenceRequestedModel;
  routingConversation: RoutingMessage[];
  agentMode?: string;
}

export type ClientMessage =
  | { case: "runRequest"; value: RunInferenceRunRequest }
  | { case: "invokeModel"; invocationId: string; request: InferenceStreamRequest }
  | { case: "cancelInvocation"; invocationId: string }
  | { case: "finishRun" };

export interface TextStreamPart {
  text: string;
  isFinal: boolean;
}

export interface ThinkingStreamPart {
  text: string;
  signature?: string;
  isFinal: boolean;
}

export interface ToolCallStreamPart {
  toolCallId: string;
  toolName: string;
  args: string;
  isComplete: boolean;
  toolIndex?: number;
}

export interface UsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
}

export interface ExtendedUsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface StreamError {
  message: string;
  code: string;
  isInputTokenLimitError: boolean;
  isOutputTokenLimitError: boolean;
  errorType: number;
}

export interface ResponseToolCall {
  toolCallId: string;
  toolName: string;
  args: JsonObject;
  rawToolCallArgs?: string;
}

export interface ResponseMessage {
  id: string;
  role: number;
  content?: string;
  toolCalls: ResponseToolCall[];
  reasoningParts: InferenceReasoningPart[];
}

export interface ResponseInfo {
  id: string;
  model: string;
  createdAt?: number;
  messages: ResponseMessage[];
  errorMessage?: string;
}

export type InferenceStreamResponse =
  | { case: "textPart"; value: TextStreamPart }
  | { case: "toolCallPart"; value: ToolCallStreamPart }
  | { case: "usage"; value: UsageInfo }
  | { case: "responseInfo"; value: ResponseInfo }
  | { case: "extendedUsage"; value: ExtendedUsageInfo }
  | { case: "providerMetadata" }
  | { case: "invocationId"; value: string }
  | { case: "error"; value: StreamError }
  | { case: "thinkingPart"; value: ThinkingStreamPart }
  | { case: "imageDescriptions" }
  | { case: "unknown"; field: number };

export interface RunReady {
  modelId: string;
  displayName?: string;
}

export interface InvocationEnd {
  invocationId: string;
  error?: { code: number; message: string };
}

export type ServerMessage =
  | { case: "heartbeat" }
  | { case: "runReady"; value: RunReady }
  | { case: "invocationResponse"; invocationId: string; response: InferenceStreamResponse }
  | { case: "invocationEnd"; value: InvocationEnd }
  | { case: "unknown"; field: number };

function encodeRequestedModel(model: InferenceRequestedModel): Uint8Array {
  return encodeFields((w) => {
    writeString(w, 1, model.modelId);
    writeBool(w, 2, model.maxMode);
    for (const p of model.parameters ?? []) {
      writeBytes(
        w,
        3,
        encodeFields((pw) => {
          writeString(pw, 1, p.id);
          writeString(pw, 2, p.value);
        }),
      );
    }
  });
}

function encodeToolCall(call: InferenceToolCall): Uint8Array {
  return encodeFields((w) => {
    writeString(w, 1, call.toolCallId);
    writeString(w, 2, call.toolName);
    writeBytes(w, 3, jsonToStructBytes(call.args));
    writeString(w, 4, call.rawToolCallArgs ?? JSON.stringify(call.args));
  });
}

function encodeReasoning(part: InferenceReasoningPart): Uint8Array {
  return encodeFields((w) => {
    writeBool(w, 1, part.isRedacted);
    writeString(w, 2, part.text);
    writeString(w, 3, part.signature);
    writeString(w, 4, part.redactedData);
    writeString(w, 5, part.modelName);
  });
}

function encodeToolResult(part: InferenceToolResultPart): Uint8Array {
  return encodeFields((w) => {
    writeString(w, 1, part.toolCallId);
    writeString(w, 2, part.toolName);
    writeBytes(w, 3, jsonToValueBytes(part.result));
    writeBool(w, 4, part.isError);
  });
}

function encodeCoreMessage(message: InferenceCoreMessage): Uint8Array {
  return encodeFields((w) => {
    writeEnum(w, 1, message.role);
    if (message.toolResults && message.toolResults.length > 0) {
      writeBytes(
        w,
        6,
        encodeFields((cw) => {
          for (const part of message.toolResults ?? []) writeBytes(cw, 1, encodeToolResult(part));
        }),
      );
    } else if (message.text !== undefined) {
      writeString(w, 2, message.text);
    }
    for (const call of message.toolCalls ?? []) writeBytes(w, 4, encodeToolCall(call));
    for (const part of message.reasoningParts ?? []) writeBytes(w, 7, encodeReasoning(part));
    writeString(w, 8, message.modelProviderMessageId);
  });
}

function encodeTool(tool: InferenceAgentTool): Uint8Array {
  return encodeFields((w) => {
    writeString(w, 1, tool.name);
    writeString(w, 2, tool.description);
    writeBytes(w, 3, jsonToStructBytes({ jsonSchema: tool.jsonSchema }));
  });
}

function encodeModelConfig(config: InferenceModelConfig): Uint8Array {
  return encodeFields((w) => {
    writeInt32(w, 1, config.maxTokens);
    writeFloat(w, 2, config.temperature);
    writeFloat(w, 3, config.topP);
    for (const stop of config.stopSequences ?? []) writeString(w, 4, stop);
  });
}

export function encodeStreamRequest(request: InferenceStreamRequest): Uint8Array {
  return encodeFields((w) => {
    for (const m of request.messages) writeBytes(w, 1, encodeCoreMessage(m));
    for (const t of request.tools) writeBytes(w, 2, encodeTool(t));
    if (request.modelConfig) writeBytes(w, 4, encodeModelConfig(request.modelConfig));
    writeString(w, 6, request.invocationId);
    if (request.requestedModel) writeBytes(w, 7, encodeRequestedModel(request.requestedModel));
    writeString(w, 8, request.conversationId);
  });
}

function encodeRunRequest(request: RunInferenceRunRequest): Uint8Array {
  return encodeFields((w) => {
    writeString(w, 1, request.conversationId);
    writeBytes(w, 3, encodeRequestedModel(request.requestedModel));
    for (const msg of request.routingConversation) {
      writeBytes(
        w,
        4,
        encodeFields((rw) => {
          writeEnum(rw, 1, msg.role);
          writeString(rw, 2, msg.text);
        }),
      );
    }
    writeString(w, 5, request.agentMode ?? "agent");
  });
}

export function encodeClientMessage(message: ClientMessage): Uint8Array {
  return encodeFields((w) => {
    switch (message.case) {
      case "runRequest":
        writeBytes(w, 1, encodeRunRequest(message.value));
        return;
      case "invokeModel":
        writeBytes(
          w,
          2,
          encodeFields((iw) => {
            writeString(iw, 1, message.invocationId);
            writeBytes(iw, 2, encodeStreamRequest(message.request));
          }),
        );
        return;
      case "cancelInvocation":
        writeBytes(
          w,
          3,
          encodeFields((cw) => writeString(cw, 1, message.invocationId)),
        );
        return;
      case "finishRun":
        w.tag(4, WireType.LengthDelimited).bytes(new Uint8Array());
        return;
    }
  });
}

function decodeRequestedModel(bytes: Uint8Array): InferenceRequestedModel {
  const model: InferenceRequestedModel = { modelId: "", parameters: [] };
  forEachField(bytes, (field, wire, reader) => {
    if (field === 1) model.modelId = expectString(reader, wire);
    else if (field === 2) model.maxMode = expectBool(reader, wire);
    else if (field === 3) {
      const p: ModelParameter = { id: "", value: "" };
      forEachField(expectBytes(reader, wire), (pf, pw, pr) => {
        if (pf === 1) p.id = expectString(pr, pw);
        else if (pf === 2) p.value = expectString(pr, pw);
        else skipUnknown(pr, pw, pf);
      });
      model.parameters?.push(p);
    } else skipUnknown(reader, wire, field);
  });
  return model;
}

function decodeToolCall(bytes: Uint8Array): InferenceToolCall {
  const call: InferenceToolCall = { toolCallId: "", toolName: "", args: {} };
  forEachField(bytes, (field, wire, reader) => {
    if (field === 1) call.toolCallId = expectString(reader, wire);
    else if (field === 2) call.toolName = expectString(reader, wire);
    else if (field === 3) call.args = structBytesToJson(expectBytes(reader, wire));
    else if (field === 4) call.rawToolCallArgs = expectString(reader, wire);
    else skipUnknown(reader, wire, field);
  });
  return call;
}

function decodeReasoning(bytes: Uint8Array): InferenceReasoningPart {
  const part: InferenceReasoningPart = { isRedacted: false, text: "" };
  forEachField(bytes, (field, wire, reader) => {
    if (field === 1) part.isRedacted = expectBool(reader, wire);
    else if (field === 2) part.text = expectString(reader, wire);
    else if (field === 3) part.signature = expectString(reader, wire);
    else if (field === 4) part.redactedData = expectString(reader, wire);
    else if (field === 5) part.modelName = expectString(reader, wire);
    else skipUnknown(reader, wire, field);
  });
  return part;
}

function decodeResponseMessage(bytes: Uint8Array): ResponseMessage {
  const msg: ResponseMessage = { id: "", role: 0, toolCalls: [], reasoningParts: [] };
  forEachField(bytes, (field, wire, reader) => {
    if (field === 1) msg.id = expectString(reader, wire);
    else if (field === 2) msg.role = expectVarint(reader, wire);
    else if (field === 3) msg.content = expectString(reader, wire);
    else if (field === 4) msg.toolCalls.push(decodeToolCall(expectBytes(reader, wire)));
    else if (field === 6) msg.reasoningParts.push(decodeReasoning(expectBytes(reader, wire)));
    else skipUnknown(reader, wire, field);
  });
  return msg;
}

function decodeResponseInfo(bytes: Uint8Array): ResponseInfo {
  const info: ResponseInfo = { id: "", model: "", messages: [] };
  forEachField(bytes, (field, wire, reader) => {
    if (field === 1) info.id = expectString(reader, wire);
    else if (field === 2) info.model = expectString(reader, wire);
    else if (field === 3) {
      if (wire !== 0) skipUnknown(reader, wire, field);
      else {
        const n = Number(reader.int64());
        if (Number.isSafeInteger(n) && n > 0) info.createdAt = n;
      }
    } else if (field === 4) info.messages.push(decodeResponseMessage(expectBytes(reader, wire)));
    else if (field === 5) info.errorMessage = expectString(reader, wire);
    else skipUnknown(reader, wire, field);
  });
  return info;
}

function decodeStreamError(bytes: Uint8Array): StreamError {
  const err: StreamError = {
    message: "",
    code: "",
    isInputTokenLimitError: false,
    isOutputTokenLimitError: false,
    errorType: 0,
  };
  forEachField(bytes, (field, wire, reader) => {
    if (field === 1) err.message = expectString(reader, wire);
    else if (field === 2) err.code = expectString(reader, wire);
    else if (field === 3) err.isInputTokenLimitError = expectBool(reader, wire);
    else if (field === 4) err.isOutputTokenLimitError = expectBool(reader, wire);
    else if (field === 5) err.errorType = expectVarint(reader, wire);
    else skipUnknown(reader, wire, field);
  });
  return err;
}

export function decodeStreamResponse(bytes: Uint8Array): InferenceStreamResponse {
  let result: InferenceStreamResponse | undefined;
  forEachField(bytes, (field, wire, reader) => {
    const set = (next: InferenceStreamResponse): void => {
      if (result !== undefined) throw driftError("InferenceStreamResponse has multiple arms");
      result = next;
    };
    switch (field) {
      case 1: {
        const value: TextStreamPart = { text: "", isFinal: false };
        forEachField(expectBytes(reader, wire), (f, wr, r) => {
          if (f === 1) value.text = expectString(r, wr);
          else if (f === 2) value.isFinal = expectBool(r, wr);
          else skipUnknown(r, wr, f);
        });
        set({ case: "textPart", value });
        return;
      }
      case 2: {
        const value: ToolCallStreamPart = { toolCallId: "", toolName: "", args: "", isComplete: false };
        forEachField(expectBytes(reader, wire), (f, wr, r) => {
          if (f === 1) value.toolCallId = expectString(r, wr);
          else if (f === 2) value.toolName = expectString(r, wr);
          else if (f === 3) value.args = expectString(r, wr);
          else if (f === 4) value.isComplete = expectBool(r, wr);
          else if (f === 5) value.toolIndex = expectVarint(r, wr);
          else skipUnknown(r, wr, f);
        });
        set({ case: "toolCallPart", value });
        return;
      }
      case 3: {
        const value: UsageInfo = { promptTokens: 0, completionTokens: 0 };
        forEachField(expectBytes(reader, wire), (f, wr, r) => {
          if (f === 1) value.promptTokens = expectVarint(r, wr);
          else if (f === 2) value.completionTokens = expectVarint(r, wr);
          else if (f === 3) value.totalTokens = expectVarint(r, wr);
          else skipUnknown(r, wr, f);
        });
        set({ case: "usage", value });
        return;
      }
      case 4:
        set({ case: "responseInfo", value: decodeResponseInfo(expectBytes(reader, wire)) });
        return;
      case 5: {
        const value: ExtendedUsageInfo = {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        };
        forEachField(expectBytes(reader, wire), (f, wr, r) => {
          if (f === 1) value.inputTokens = expectVarint(r, wr);
          else if (f === 2) value.outputTokens = expectVarint(r, wr);
          else if (f === 3) value.cacheReadTokens = expectVarint(r, wr);
          else if (f === 4) value.cacheWriteTokens = expectVarint(r, wr);
          else skipUnknown(r, wr, f);
        });
        set({ case: "extendedUsage", value });
        return;
      }
      case 6:
        skipUnknown(reader, wire, field);
        set({ case: "providerMetadata" });
        return;
      case 7: {
        let id = "";
        forEachField(expectBytes(reader, wire), (f, wr, r) => {
          if (f === 1) id = expectString(r, wr);
          else skipUnknown(r, wr, f);
        });
        set({ case: "invocationId", value: id });
        return;
      }
      case 8:
        set({ case: "error", value: decodeStreamError(expectBytes(reader, wire)) });
        return;
      case 9: {
        const value: ThinkingStreamPart = { text: "", isFinal: false };
        forEachField(expectBytes(reader, wire), (f, wr, r) => {
          if (f === 1) value.text = expectString(r, wr);
          else if (f === 2) value.signature = expectString(r, wr);
          else if (f === 3) value.isFinal = expectBool(r, wr);
          else skipUnknown(r, wr, f);
        });
        set({ case: "thinkingPart", value });
        return;
      }
      case 10:
        skipUnknown(reader, wire, field);
        set({ case: "imageDescriptions" });
        return;
      default:
        skipUnknown(reader, wire, field);
        set({ case: "unknown", field });
    }
  });
  if (result === undefined) throw driftError("InferenceStreamResponse has no arm");
  return result;
}

function decodeRunReady(bytes: Uint8Array): RunReady {
  const ready: RunReady = { modelId: "" };
  forEachField(bytes, (field, wire, reader) => {
    if (field === 1) {
      const model = decodeRequestedModel(expectBytes(reader, wire));
      ready.modelId = model.modelId;
    } else if (field === 3) ready.displayName = expectString(reader, wire);
    else skipUnknown(reader, wire, field);
  });
  return ready;
}

function decodeInvocationEnd(bytes: Uint8Array): InvocationEnd {
  const end: InvocationEnd = { invocationId: "" };
  forEachField(bytes, (field, wire, reader) => {
    if (field === 1) end.invocationId = expectString(reader, wire);
    else if (field === 2) {
      const err = { code: 0, message: "" };
      forEachField(expectBytes(reader, wire), (f, wr, r) => {
        if (f === 1) err.code = expectVarint(r, wr);
        else if (f === 2) err.message = expectString(r, wr);
        else skipUnknown(r, wr, f);
      });
      end.error = err;
    } else skipUnknown(reader, wire, field);
  });
  return end;
}

export function decodeServerMessage(bytes: Uint8Array): ServerMessage {
  let result: ServerMessage | undefined;
  forEachField(bytes, (field, wire, reader) => {
    const set = (next: ServerMessage): void => {
      if (result !== undefined) throw driftError("RunInferenceServerMessage has multiple arms");
      result = next;
    };
    switch (field) {
      case 1:
        skipUnknown(reader, wire, field);
        set({ case: "heartbeat" });
        return;
      case 2:
        set({ case: "runReady", value: decodeRunReady(expectBytes(reader, wire)) });
        return;
      case 3: {
        let invocationId = "";
        let response: InferenceStreamResponse | undefined;
        forEachField(expectBytes(reader, wire), (f, wr, r) => {
          if (f === 1) invocationId = expectString(r, wr);
          else if (f === 2) response = decodeStreamResponse(expectBytes(r, wr));
          else skipUnknown(r, wr, f);
        });
        if (response === undefined) throw driftError("invocation_response has no payload");
        set({ case: "invocationResponse", invocationId, response });
        return;
      }
      case 4:
        set({ case: "invocationEnd", value: decodeInvocationEnd(expectBytes(reader, wire)) });
        return;
      default:
        skipUnknown(reader, wire, field);
        set({ case: "unknown", field });
    }
  });
  if (result === undefined) throw driftError("RunInferenceServerMessage has no arm");
  return result;
}

export function assertKnownServerFrame(message: ServerMessage): void {
  if (message.case === "unknown") {
    throw driftError(`${EXEC_DRIFT_MESSAGE} (unknown RunInference server field ${String(message.field)})`);
  }
}

/** Used by tests to inject a forged exec-shaped frame at the mapper boundary. */
export function rejectExecFrame(frame: unknown): void {
  if (frame === null || typeof frame !== "object") return;
  const keys = Object.keys(frame);
  const exec = keys.some((k) => /exec/i.test(k) || k === "shell" || k === "mcpArgs");
  if (exec) throw driftError(EXEC_DRIFT_MESSAGE);
}
