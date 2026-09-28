// SPDX-License-Identifier: AGPL-3.0-or-later
/** pi 0.87: TranscriptContext.messages carry system prompt + tools. */
import {
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type JsonObject,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { localError } from "../errors.ts";
import type { InferenceIR, IrEvent, IrImage, IrMessage } from "../session/ir.ts";

function textOf(content: string | { type: string; text?: string }[]): string {
  if (typeof content === "string") return content;
  return content.flatMap((p) => (p.type === "text" && p.text ? [p.text] : [])).join("");
}

/** pi 0.87: ImageContent is `{ type:"image", data, mimeType }`. */
function imagesOf(content: unknown, where: string): IrImage[] {
  if (!Array.isArray(content)) return [];
  const images: IrImage[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const typed = part as { type?: string; data?: unknown; mimeType?: unknown };
    if (typed.type !== "image") continue;
    if (typeof typed.data !== "string" || typeof typed.mimeType !== "string") {
      throw localError(`Malformed image part (${where})`, "ImageContent needs base64 data and mimeType");
    }
    images.push({ data: typed.data, mimeType: typed.mimeType });
  }
  return images;
}

function jsonSchemaOf(parameters: unknown): Record<string, unknown> {
  if (parameters !== null && typeof parameters === "object") {
    return parameters as Record<string, unknown>;
  }
  return { type: "object", properties: {} };
}

export function transcriptToIr(
  context: TranscriptContext,
  model: Model<string>,
  options?: SimpleStreamOptions,
): InferenceIR {
  const tools = getCurrentTools(context.messages);
  const systemPrompt = getCurrentSystemPrompt(context.messages);
  const messages: IrMessage[] = [];
  for (const msg of context.messages) {
    if (msg.role === "system") continue;
    if (msg.role === "user") {
      const images = imagesOf(msg.content, "user");
      messages.push({
        role: "user",
        text: textOf(msg.content),
        ...(images.length > 0 ? { images } : {}),
      });
      continue;
    }
    if (msg.role === "assistant") {
      const text: string[] = [];
      const thinking: IrMessage["thinking"] = [];
      const toolCalls: IrMessage["toolCalls"] = [];
      for (const part of msg.content) {
        if (part.type === "text") text.push(part.text);
        else if (part.type === "thinking") {
          thinking.push({
            text: part.thinking,
            signature: part.thinkingSignature,
            redacted: part.redacted,
          });
        } else if (part.type === "toolCall") {
          toolCalls.push({ id: part.id, name: part.name, arguments: part.arguments });
        }
      }
      messages.push({
        role: "assistant",
        text: text.join("") || undefined,
        thinking: thinking.length ? thinking : undefined,
        toolCalls: toolCalls.length ? toolCalls : undefined,
        responseId: msg.responseId,
      });
      continue;
    }
    if (msg.role === "toolResult") {
      const images = imagesOf(msg.content, "toolResult");
      const text = textOf(msg.content);
      messages.push({
        role: "tool",
        toolResult: {
          toolCallId: msg.toolCallId,
          toolName: msg.toolName,
          result: text,
          isError: msg.isError,
          ...(images.length > 0 ? { images } : {}),
        },
      });
    }
  }
  // Cursor encodes thinking effort as a variant PARAMETER (id varies per family:
  // `reasoning_effort` for grok, `reasoning` for gpt-5.x, `effort` for Claude). The
  // catalog records the parameters for each level in `samplingParams.cursorParams`.
  // Read both carriers, like cursorMaxMode/cursorContext above: a request may carry
  // overrides in its own samplingParams, and pi's custom-model fallback has none on
  // the model row.
  const cursorParams = (options?.samplingParams?.cursorParams ?? model.samplingParams?.cursorParams) as
    | Record<string, { id: string; value: string }[]>
    | undefined;
  const effortParams = options?.reasoning === undefined ? undefined : cursorParams?.[options.reasoning];
  const maxMode = options?.samplingParams?.cursorMaxMode ?? model.samplingParams?.cursorMaxMode;
  const contextParam = options?.samplingParams?.cursorContext ?? model.samplingParams?.cursorContext;
  return {
    sessionId: options?.sessionId && options.sessionId !== "" ? options.sessionId : crypto.randomUUID(),
    systemPrompt,
    messages,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      jsonSchema: jsonSchemaOf(t.parameters),
    })),
    // `model.id` stays the base Cursor id: the per-effort legacy slugs AgentService
    // rejects as a model id are carried as `effortParams` instead.
    modelId: model.id.replace(/-max$/, ""),
    maxMode: maxMode === true || model.id.endsWith("-max"),
    contextParam: typeof contextParam === "string" ? contextParam : undefined,
    ...(effortParams && effortParams.length > 0 ? { effortParams } : {}),
    maxTokens: options?.maxTokens,
    temperature: options?.temperature,
    contextWindow: model.contextWindow,
  };
}

export function emptyAssistant(model: Model<string>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

export interface PiSink {
  push: (event: unknown) => void;
  output: AssistantMessage;
}

/**
 * Blocks closed by an `is_final` event. `PROTOCOL.md §2.2: is_final closes the
 * block — later deltas of the same kind must open a new one; appending to a
 * historical block (e.g. text -> tool_call -> text) misorders Pi's content array.
 */
const closedBlocks = new WeakMap<PiSink, Set<object>>();

function closedFor(sink: PiSink): Set<object> {
  let set = closedBlocks.get(sink);
  if (!set) {
    set = new Set();
    closedBlocks.set(sink, set);
  }
  return set;
}

export function applyIrEvent(sink: PiSink, event: IrEvent): void {
  const output = sink.output;
  switch (event.type) {
    case "reset":
      // Drop streamed-so-far content (e.g. a stale-remote resume attempt is retried
      // as a rebuild). The Pi stream already carried those deltas to the UI; the
      // final assistant message is rebuilt cleanly from here.
      output.content = [];
      closedBlocks.get(sink)?.clear();
      return;
    case "warning":
      output.diagnostics = [
        ...(output.diagnostics ?? []),
        { type: "cursor-provider-warning", timestamp: Date.now(), details: { message: event.message } },
      ];
      return;
    case "usage":
      output.usage.input = event.input;
      output.usage.output = event.output;
      output.usage.cacheRead = event.cacheRead;
      output.usage.cacheWrite = event.cacheWrite;
      output.usage.totalTokens = event.input + event.output + event.cacheRead + event.cacheWrite;
      return;
    case "text": {
      if (event.delta === "" && !event.final) return;
      const closed = closedFor(sink);
      const tail = output.content.at(-1);
      let idx: number;
      let block: TextContent;
      if (tail?.type === "text" && !closed.has(tail)) {
        idx = output.content.length - 1;
        block = tail as TextContent;
      } else {
        block = { type: "text", text: "" };
        output.content.push(block);
        idx = output.content.length - 1;
        sink.push({ type: "text_start", contentIndex: idx, partial: output });
      }
      if (event.delta) {
        block.text += event.delta;
        sink.push({ type: "text_delta", contentIndex: idx, delta: event.delta, partial: output });
      }
      if (event.final) {
        closed.add(block);
        sink.push({ type: "text_end", contentIndex: idx, content: block.text, partial: output });
      }
      return;
    }
    case "thinking": {
      if (event.delta === "" && !event.final) return;
      const closed = closedFor(sink);
      const tail = output.content.at(-1);
      let idx: number;
      let block: ThinkingContent;
      if (tail?.type === "thinking" && !closed.has(tail)) {
        idx = output.content.length - 1;
        block = tail as ThinkingContent;
      } else {
        block = {
          type: "thinking",
          thinking: "",
          ...(event.signature ? { thinkingSignature: event.signature } : {}),
        };
        output.content.push(block);
        idx = output.content.length - 1;
        sink.push({ type: "thinking_start", contentIndex: idx, partial: output });
      }
      if (event.signature) block.thinkingSignature = event.signature;
      if (event.delta) {
        block.thinking += event.delta;
        sink.push({ type: "thinking_delta", contentIndex: idx, delta: event.delta, partial: output });
      }
      if (event.final) {
        closed.add(block);
        sink.push({ type: "thinking_end", contentIndex: idx, content: block.thinking, partial: output });
      }
      return;
    }
    case "tool_call": {
      let idx = output.content.findIndex((c) => c.type === "toolCall" && (c as ToolCall).id === event.id);
      if (idx < 0) {
        const block: ToolCall = { type: "toolCall", id: event.id, name: event.name, arguments: {} };
        output.content.push(block);
        idx = output.content.length - 1;
        sink.push({ type: "toolcall_start", contentIndex: idx, partial: output });
      }
      const block = output.content[idx] as ToolCall;
      if (event.arguments) block.arguments = event.arguments as JsonObject;
      if (event.argsDelta) {
        sink.push({ type: "toolcall_delta", contentIndex: idx, delta: event.argsDelta, partial: output });
      }
      if (event.complete) {
        sink.push({ type: "toolcall_end", contentIndex: idx, toolCall: block, partial: output });
      }
      return;
    }
    case "done":
    case "error":
      return;
  }
}

export type { Message };
