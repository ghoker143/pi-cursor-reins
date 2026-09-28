// SPDX-License-Identifier: AGPL-3.0-or-later
import { pathToFileURL } from "node:url";
import { CONNECT_MAX_FRAME_BYTES } from "../constants.ts";
import { localError } from "../errors.ts";
import type { InferenceIR } from "../session/ir.ts";
import {
  encodeConversationState,
  encodeMcpTools,
  encodeRequestedModel,
  encodeRunRequest,
  encodeSelectedContextBlob,
  encodeUserMessage,
  overlayCheckpointState,
  type McpToolWire,
} from "../proto/agent.ts";
import { BlobStore } from "./blob-store.ts";
import { localToolPolicyText } from "./policy.ts";
import { buildRootPromptMessages, encodeRootPromptMessage, splitCurrentUser, systemPromptRootMessage } from "./root-prompt.ts";
import { toWireImages } from "./images.ts";
import type { ConversationHandle } from "./handle-store.ts";
import { blobsIntoStore } from "./handle-store.ts";

export interface AgentRequest {
  bytes: Uint8Array;
  blobStore: BlobStore;
  tools: McpToolWire[];
  workspaceUri: string;
  userText: string;
  conversationId: string;
}

export function workspaceUri(cwd = process.cwd()): string {
  return pathToFileURL(cwd).href;
}

export function mcpToolsOf(ir: InferenceIR): McpToolWire[] {
  return ir.tools.map((t) => ({
    name: t.name,
    description: t.description,
    jsonSchema: t.jsonSchema,
  }));
}

export function buildAgentRequest(
  ir: InferenceIR,
  blobStore?: BlobStore,
  resume?: ConversationHandle,
): AgentRequest {
  const store = blobStore ?? new BlobStore();
  const { history, userText, userImages } = splitCurrentUser(ir);
  const uri = workspaceUri();
  const tools = mcpToolsOf(ir);
  if (resume) blobsIntoStore(store, resume.blobs);
  const prompt = resume
    ? [systemPromptRootMessage(localToolPolicyText(ir.tools) + (ir.systemPrompt.trim() ? `\n\n${ir.systemPrompt}` : ""))]
    : buildRootPromptMessages(ir, history);
  const promptIds = prompt.map((m) => store.put(encodeRootPromptMessage(m)));
  const selected = store.put(encodeSelectedContextBlob(promptIds, "pi"));
  const conversationState = resume
    ? overlayCheckpointState(resume.checkpoint, { rootPromptBlobIds: promptIds, workspaceUri: uri })
    : encodeConversationState({ rootPromptBlobIds: promptIds, workspaceUri: uri });
  const messageId = crypto.randomUUID();
  const conversationId = resume?.conversationId ?? crypto.randomUUID();
  const images = toWireImages(userImages, "user");
  const bytes = encodeRunRequest({
    conversationState,
    userMessage: encodeUserMessage({ text: userText, messageId, selectedContextBlob: selected, images }),
    requestedModel: encodeRequestedModel(ir.modelId, ir.maxMode, ir.contextParam, ir.effortParams),
    mcpTools: encodeMcpTools(tools),
    conversationId,
  });
  if (bytes.byteLength > CONNECT_MAX_FRAME_BYTES) {
    throw localError(
      "AgentService request would exceed the 16 MiB Connect frame cap",
      "use a smaller image or compact the Pi session",
    );
  }
  return { bytes, blobStore: store, tools, workspaceUri: uri, userText, conversationId };
}
