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
import { buildRootPromptMessages, composeRules, encodeRootPromptMessage, splitCurrentUser, systemPromptRootMessage } from "./root-prompt.ts";
import { toWireImages } from "./images.ts";
import type { ConversationHandle } from "./handle-store.ts";
import { blobsIntoStore, toolsetKeyOf } from "./handle-store.ts";

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
  // The backend retains the mcp_tools registration across resume requests
  // (PROTOCOL-AGENT §5.1), so re-sending the unchanged set every turn is pure
  // token burn. Omit when the handle proves we already sent exactly this set;
  // re-send on any change (or for handles predating toolsetKey).
  // CURSOR_PROVIDER_RESEND_MCP_ON_RESUME=1 restores unconditional re-send.
  const omitOnResume =
    resume !== undefined &&
    process.env.CURSOR_PROVIDER_RESEND_MCP_ON_RESUME !== "1" &&
    resume.toolsetKey !== undefined &&
    resume.toolsetKey === toolsetKeyOf(tools);
  if (resume) blobsIntoStore(store, resume.blobs);
  const prompt = resume
    ? [systemPromptRootMessage(composeRules(ir))]
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
    // requested_model.parameters id "context" is rejected by AgentService as
    // not_found for every value (128k/256k/1m) and family (grok, claude) —
    // measured 2026-10-03; the slug alone passes and already encodes the
    // variant's context. The IR keeps contextParam for the inference channel,
    // which selects variants by parameter (session/request.ts).
    requestedModel: encodeRequestedModel(ir.modelId, ir.maxMode, undefined, ir.effortParams),
    mcpTools: omitOnResume ? encodeMcpTools([]) : encodeMcpTools(tools),
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
