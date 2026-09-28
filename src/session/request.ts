// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  InferenceMessageRole,
  RoutingRole,
  type ClientMessage,
  type InferenceCoreMessage,
  type InferenceStreamRequest,
  type RunInferenceRunRequest,
} from "../proto/inference.ts";
import { localError } from "../errors.ts";
import type { InferenceIR, IrMessage } from "./ir.ts";

const CHARS_PER_TOKEN = 4;
/** Mirrors Pi's estimator: an image counts as 4800 chars worth of tokens, not its base64 length. */
const IMAGE_TOKENS = 1200;

export function estimateTokens(ir: InferenceIR): number {
  let chars = ir.systemPrompt.length;
  for (const m of ir.messages) {
    chars += m.text?.length ?? 0;
    chars += (m.images?.length ?? 0) * (IMAGE_TOKENS * CHARS_PER_TOKEN);
    chars += JSON.stringify(m.toolCalls ?? []).length;
    chars += JSON.stringify(m.toolResult ?? {}).length;
    chars += (m.toolResult?.images?.length ?? 0) * (IMAGE_TOKENS * CHARS_PER_TOKEN);
    for (const t of m.thinking ?? []) chars += t.text.length;
  }
  chars += JSON.stringify(ir.tools).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function truncateHistory(ir: InferenceIR): { ir: InferenceIR; warning?: string } {
  if (ir.contextWindow <= 0) return { ir };
  if (estimateTokens(ir) <= ir.contextWindow) return { ir };
  const messages = [...ir.messages];
  while (messages.length > 1 && estimateTokens({ ...ir, messages }) > ir.contextWindow) {
    messages.shift();
  }
  // Never start the replay with an orphan tool result or assistant tool-call leg:
  // the replayed conversation must begin at a user turn.
  while (messages.length > 1 && messages[0]?.role !== "user") messages.shift();
  return {
    ir: { ...ir, messages },
    warning: `Transcript truncated to fit contextWindow=${String(ir.contextWindow)}; oldest non-system turns dropped.`,
  };
}

function requestedModelParams(ir: InferenceIR): { id: string; value: string }[] | undefined {
  const params: { id: string; value: string }[] = [];
  if (ir.contextParam) params.push({ id: "context", value: ir.contextParam });
  // Effort/thinking is a variant parameter; see InferenceIR.effortParams.
  for (const param of ir.effortParams ?? []) params.push(param);
  return params.length > 0 ? params : undefined;
}

function toCore(message: IrMessage): InferenceCoreMessage {
  if (message.role === "tool") {
    if (!message.toolResult) throw localError("tool message missing toolResult", "file a bug in pi-cursor-provider compat");
    return {
      role: InferenceMessageRole.TOOL,
      toolResults: [message.toolResult],
    };
  }
  if (message.role === "system") {
    return { role: InferenceMessageRole.SYSTEM, text: message.text ?? "" };
  }
  if (message.role === "user") {
    return { role: InferenceMessageRole.USER, text: message.text ?? "" };
  }
  return {
    role: InferenceMessageRole.ASSISTANT,
    text: message.text,
    toolCalls: message.toolCalls?.map((c) => ({
      toolCallId: c.id,
      toolName: c.name,
      args: c.arguments,
      rawToolCallArgs: JSON.stringify(c.arguments),
    })),
    reasoningParts: message.thinking?.map((t) => ({
      isRedacted: t.redacted === true,
      text: t.text,
      signature: t.redacted ? undefined : t.signature,
      redactedData: t.redacted ? t.signature : undefined,
    })),
    modelProviderMessageId: message.responseId,
  };
}

export function buildStreamRequest(ir: InferenceIR, invocationId: string): InferenceStreamRequest {
  const messages: InferenceCoreMessage[] = [];
  if (ir.systemPrompt !== "") {
    messages.push({ role: InferenceMessageRole.SYSTEM, text: ir.systemPrompt });
  }
  for (const m of ir.messages) messages.push(toCore(m));
  const frame = encodeSizeCheck(messages, ir);
  void frame;
  return {
    messages,
    tools: ir.tools.map((t) => ({ name: t.name, description: t.description, jsonSchema: t.jsonSchema })),
    modelConfig:
      ir.maxTokens === undefined && ir.temperature === undefined
        ? undefined
        : { maxTokens: ir.maxTokens, temperature: ir.temperature },
    requestedModel: {
      modelId: ir.modelId,
      maxMode: ir.maxMode,
      parameters: requestedModelParams(ir),
    },
    conversationId: ir.sessionId,
    invocationId,
  };
}

function encodeSizeCheck(messages: InferenceCoreMessage[], ir: InferenceIR): void {
  const approx = JSON.stringify({ messages, tools: ir.tools }).length;
  if (approx > 12 * 1024 * 1024) {
    throw localError(
      "Inference request would exceed the 16 MiB Connect frame cap",
      "compact the Pi session or reduce tool-result size",
    );
  }
}

export function buildRunRequest(ir: InferenceIR): RunInferenceRunRequest {
  if (ir.sessionId === "") throw localError("conversation_id is empty", "pass SimpleStreamOptions.sessionId");
  const routing = ir.messages.flatMap((m) => {
    if (m.role === "tool" || m.role === "system") return [];
    const text = m.text ?? "";
    if (text === "") return [];
    return [
      {
        role: m.role === "user" ? RoutingRole.USER : RoutingRole.ASSISTANT,
        text,
      },
    ];
  });
  return {
    conversationId: ir.sessionId,
    requestedModel: {
      modelId: ir.modelId,
      maxMode: ir.maxMode,
      parameters: requestedModelParams(ir),
    },
    routingConversation: routing,
    agentMode: "agent",
  };
}

export function clientRunRequest(ir: InferenceIR): ClientMessage {
  return { case: "runRequest", value: buildRunRequest(ir) };
}

export function clientInvoke(ir: InferenceIR, invocationId: string): ClientMessage {
  return { case: "invokeModel", invocationId, request: buildStreamRequest(ir, invocationId) };
}
