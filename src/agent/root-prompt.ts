// SPDX-License-Identifier: AGPL-3.0-or-later
import { MAX_REPLAYED_TOOL_RESULT_CHARS } from "../constants.ts";
import type { InferenceIR, IrImage, IrMessage } from "../session/ir.ts";
import { cursorMcpToolName, mcpContractText } from "./policy.ts";

export interface RootPromptTextPart {
  type: "text";
  text: string;
}

export interface RootPromptImagePart {
  type: "image";
  image: string;
}

export interface RootPromptToolCallPart {
  type: "tool-call";
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
}

export interface RootPromptToolResultPart {
  type: "tool-result";
  toolCallId: string;
  toolName: string;
  result: string;
  isError?: boolean;
  experimental_content?: Array<{ type: "image"; data: string; mimeType: string }>;
}

export type RootPromptMessage =
  | { role: "user"; content: Array<RootPromptTextPart | RootPromptImagePart> }
  | { role: "assistant"; content: Array<RootPromptTextPart | RootPromptToolCallPart> }
  | { role: "tool"; content: RootPromptToolResultPart[] };

function truncateResult(text: string): string {
  if (text.length <= MAX_REPLAYED_TOOL_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_REPLAYED_TOOL_RESULT_CHARS)}\n\n[pi-cursor-provider truncated this replayed tool result.]`;
}

export function systemPromptRootMessage(systemPrompt: string): RootPromptMessage {
  return {
    role: "user",
    content: [{ type: "text", text: `<rules>\n${systemPrompt}\n</rules>` }],
  };
}

function resultText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function splitCurrentUser(ir: InferenceIR): { history: IrMessage[]; userText: string; userImages: IrImage[] } {
  const messages = ir.messages;
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return { history: messages, userText: "", userImages: [] };
  const last = messages[lastUser];
  const userText = last?.text ?? "";
  const userImages = last?.images ?? [];
  const after = messages.slice(lastUser + 1);
  // Trailing messages after the last user turn are an interrupted turn (assistant
  // tool calls + Pi tool results that the remote side never consumed — a dead run
  // cannot be resumed into, so the caller rebuilds). Keep them in `history` so the
  // rebuild replays them: dropping them would make the remote model re-request the
  // tool and Pi would execute it twice. The trade-off is that the last user text
  // appears once in the replayed journal and once as the live userMessage; that is
  // deliberate and cheaper than duplicate tool execution.
  if (after.length > 0) return { history: messages, userText, userImages };
  return { history: messages.slice(0, lastUser), userText, userImages };
}

export function trailingToolResults(
  ir: InferenceIR,
): Map<string, { result: string; isError: boolean; images: IrImage[] }> {
  const out = new Map<string, { result: string; isError: boolean; images: IrImage[] }>();
  for (let i = ir.messages.length - 1; i >= 0; i -= 1) {
    const msg = ir.messages[i];
    if (msg?.role === "tool" && msg.toolResult) {
      out.set(msg.toolResult.toolCallId, {
        result: resultText(msg.toolResult.result),
        isError: msg.toolResult.isError,
        images: msg.toolResult.images ?? [],
      });
      continue;
    }
    break;
  }
  return out;
}

/** Rules for the root prompt: pi's system prompt plus the compact contract for
 * Pi-only tools (their schemas never reach the model — PROTOCOL-AGENT §5.1). */
export function composeRules(ir: InferenceIR): string {
  const contract = mcpContractText(ir.tools);
  const sys = ir.systemPrompt.trim();
  if (contract === "") return ir.systemPrompt;
  return sys === "" ? contract : `${ir.systemPrompt}\n\n${contract}`;
}

export function buildRootPromptMessages(ir: InferenceIR, history: IrMessage[]): RootPromptMessage[] {
  const rules = composeRules(ir);
  const messages: RootPromptMessage[] = [];
  if (rules.trim()) messages.push(systemPromptRootMessage(rules));

  for (const msg of history) {
    if (msg.role === "user") {
      const text = (msg.text ?? "").trim();
      const content: Array<RootPromptTextPart | RootPromptImagePart> = [];
      if (text) {
        content.push({ type: "text", text: `<user_query>\n${text}\n</user_query>` });
      }
      for (const image of msg.images ?? []) {
        content.push({ type: "image", image: `data:${image.mimeType};base64,${image.data}` });
      }
      if (content.length > 0) messages.push({ role: "user", content });
      continue;
    }
    if (msg.role === "assistant") {
      const content: Array<RootPromptTextPart | RootPromptToolCallPart> = [];
      if (msg.text) content.push({ type: "text", text: msg.text });
      for (const call of msg.toolCalls ?? []) {
        content.push({
          type: "tool-call",
          toolCallId: call.id,
          toolName: cursorMcpToolName(call.name),
          args: call.arguments,
        });
      }
      if (content.length > 0) messages.push({ role: "assistant", content });
      continue;
    }
    if (msg.role === "tool" && msg.toolResult) {
      const last = messages[messages.length - 1];
      const experimental =
        msg.toolResult.images && msg.toolResult.images.length > 0
          ? msg.toolResult.images.map((image) => ({
              type: "image" as const,
              data: image.data,
              mimeType: image.mimeType,
            }))
          : undefined;
      const part: RootPromptToolResultPart = {
        type: "tool-result",
        toolCallId: msg.toolResult.toolCallId,
        toolName: cursorMcpToolName(msg.toolResult.toolName),
        result: truncateResult(resultText(msg.toolResult.result)),
        ...(msg.toolResult.isError ? { isError: true } : {}),
        ...(experimental ? { experimental_content: experimental } : {}),
      };
      if (last?.role === "tool") last.content.push(part);
      else messages.push({ role: "tool", content: [part] });
    }
  }
  return messages;
}

export function encodeRootPromptMessage(message: RootPromptMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(message));
}
