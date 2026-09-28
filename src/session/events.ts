// SPDX-License-Identifier: AGPL-3.0-or-later
import { InferenceStreamErrorType, type ServerMessage, rejectExecFrame } from "../proto/inference.ts";
import { EXEC_DRIFT_MESSAGE, driftError } from "../errors.ts";
import type { IrEvent } from "./ir.ts";

export interface MapperState {
  events: IrEvent[];
  stopReason: "stop" | "toolUse" | "length" | "error";
  errorMessage?: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
  sawExtendedUsage: boolean;
  openTools: Map<string, { name: string; json: string }>;
  completedTools: number;
}

export function createMapper(): MapperState {
  return {
    events: [],
    stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    sawExtendedUsage: false,
    openTools: new Map(),
    completedTools: 0,
  };
}

function errorKindMessage(err: {
  message: string;
  code: string;
  isInputTokenLimitError: boolean;
  isOutputTokenLimitError: boolean;
  errorType: number;
}): { stop: MapperState["stopReason"]; message: string } {
  const base = err.message === "" ? err.code || "Cursor inference failed" : err.message;
  if (err.isInputTokenLimitError || err.errorType === InferenceStreamErrorType.INPUT_TOKEN_LIMIT) {
    return { stop: "error", message: `context_length_exceeded: ${base}` };
  }
  if (err.isOutputTokenLimitError || err.errorType === InferenceStreamErrorType.OUTPUT_TOKEN_LIMIT) {
    return { stop: "length", message: base };
  }
  return { stop: "error", message: base };
}

export function applyServerMessage(state: MapperState, message: ServerMessage): void {
  rejectExecFrame(message);
  switch (message.case) {
    case "heartbeat":
    case "runReady":
      return;
    case "unknown":
      throw driftError(`${EXEC_DRIFT_MESSAGE} (unknown RunInference server field ${String(message.field)})`);
    case "invocationEnd":
      if (message.value.error) {
        state.stopReason = "error";
        state.errorMessage = message.value.error.message || `Cursor invocation error ${String(message.value.error.code)}`;
      }
      if (state.completedTools > 0 && state.stopReason === "stop") state.stopReason = "toolUse";
      if (state.openTools.size > 0) throw driftError("Cursor invocation ended with incomplete tool calls");
      state.events.push({
        type: "done",
        stopReason: state.stopReason,
        errorMessage: state.errorMessage,
      });
      return;
    case "invocationResponse": {
      const inner = message.response;
      switch (inner.case) {
        case "textPart":
          state.events.push({ type: "text", delta: inner.value.text, final: inner.value.isFinal });
          return;
        case "thinkingPart":
          state.events.push({
            type: "thinking",
            delta: inner.value.text,
            signature: inner.value.signature,
            final: inner.value.isFinal,
          });
          return;
        case "toolCallPart": {
          const part = inner.value;
          if (part.toolCallId === "") throw driftError("Cursor tool call has no id");
          let open = state.openTools.get(part.toolCallId);
          if (!open) {
            if (part.toolName === "") throw driftError("Cursor tool call starts without a name");
            open = { name: part.toolName, json: "" };
            state.openTools.set(part.toolCallId, open);
            state.events.push({ type: "tool_call", id: part.toolCallId, name: part.toolName });
          }
          if (part.toolName !== "" && part.toolName !== open.name) {
            throw driftError(`Cursor tool call '${part.toolCallId}' changed name`);
          }
          if (!part.isComplete) {
            open.json += part.args;
            state.events.push({ type: "tool_call", id: part.toolCallId, name: open.name, argsDelta: part.args });
            return;
          }
          // PROTOCOL.md §3: args stream as JSON string fragments concatenated until
          // is_complete; the complete frame's own args are the final fragment. Using
          // only the final frame would silently turn a delta-streamed call into {}.
          const full = open.json + part.args;
          let parsed: unknown;
          try {
            parsed = full === "" ? {} : JSON.parse(full);
          } catch (concatCause) {
            // Tolerate the other observed shape — complete frame repeating the full
            // args after delta frames — before declaring drift.
            if (open.json !== "" && part.args !== "") {
              try {
                parsed = JSON.parse(part.args);
              } catch {
                throw driftError(
                  `Cursor tool call '${part.toolCallId}' completed with invalid JSON arguments`,
                  concatCause,
                );
              }
            } else {
              throw driftError(
                `Cursor tool call '${part.toolCallId}' completed with invalid JSON arguments`,
                concatCause,
              );
            }
          }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            throw driftError(`Cursor tool call '${part.toolCallId}' arguments are not an object`);
          }
          state.openTools.delete(part.toolCallId);
          state.completedTools += 1;
          state.events.push({
            type: "tool_call",
            id: part.toolCallId,
            name: open.name,
            arguments: parsed as Record<string, unknown>,
            complete: true,
          });
          return;
        }
        case "extendedUsage":
          state.sawExtendedUsage = true;
          state.usage = {
            input: inner.value.inputTokens,
            output: inner.value.outputTokens,
            cacheRead: inner.value.cacheReadTokens,
            cacheWrite: inner.value.cacheWriteTokens,
          };
          state.events.push({ type: "usage", ...state.usage });
          return;
        case "usage":
          if (state.sawExtendedUsage) return;
          state.usage = {
            input: inner.value.promptTokens,
            output: inner.value.completionTokens,
            cacheRead: 0,
            cacheWrite: 0,
          };
          state.events.push({ type: "usage", ...state.usage });
          return;
        case "error": {
          const mapped = errorKindMessage(inner.value);
          state.stopReason = mapped.stop;
          state.errorMessage = mapped.message;
          return;
        }
        case "responseInfo":
          if (inner.value.errorMessage) {
            state.stopReason = "error";
            state.errorMessage = inner.value.errorMessage;
          }
          return;
        case "providerMetadata":
        case "imageDescriptions":
          return;
        case "invocationId":
          return;
        case "unknown":
          throw driftError(`unrecognized InferenceStreamResponse arm field ${String(inner.field)}`);
      }
    }
  }
}
