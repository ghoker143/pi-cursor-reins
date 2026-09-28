// SPDX-License-Identifier: AGPL-3.0-or-later
/** Pi `ImageContent`: base64 payload + mime. PROTOCOL-AGENT §2.1 / §8. */
export interface IrImage {
  data: string;
  mimeType: string;
}

export interface IrMessage {
  role: "system" | "user" | "assistant" | "tool";
  text?: string;
  images?: IrImage[];
  toolCalls?: { id: string; name: string; arguments: Record<string, unknown> }[];
  thinking?: { text: string; signature?: string; redacted?: boolean }[];
  toolResult?: { toolCallId: string; toolName: string; result: unknown; isError: boolean; images?: IrImage[] };
  responseId?: string;
}

export interface IrTool {
  name: string;
  description: string;
  jsonSchema: Record<string, unknown>;
}

export interface InferenceIR {
  sessionId: string;
  systemPrompt: string;
  messages: IrMessage[];
  tools: IrTool[];
  modelId: string;
  maxMode: boolean;
  contextParam?: string;
  /**
   * Cursor variant parameters for the selected thinking level (e.g.
   * `{id:"reasoning_effort", value:"high"}`). Cursor encodes effort as a variant
   * parameter, NOT as a distinct model id: the legacy slugs it also publishes
   * (`grok-4.7-high`) are rejected by AgentService as `requested_model.model_id`.
   */
  effortParams?: { id: string; value: string }[];
  maxTokens?: number;
  temperature?: number;
  contextWindow: number;
}

export type IrEvent =
  | { type: "text"; delta: string; final?: boolean }
  | { type: "thinking"; delta: string; signature?: string; final?: boolean }
  | { type: "tool_call"; id: string; name: string; argsDelta?: string; arguments?: Record<string, unknown>; complete?: boolean }
  | { type: "usage"; input: number; output: number; cacheRead: number; cacheWrite: number }
  | { type: "warning"; message: string }
  | { type: "done"; stopReason: "stop" | "toolUse" | "length" | "error"; errorMessage?: string }
  | { type: "error"; kind: string; message: string }
  /** Live-sink only: drop content accumulated so far (e.g. before a stale-remote rebuild retry). */
  | { type: "reset" };
