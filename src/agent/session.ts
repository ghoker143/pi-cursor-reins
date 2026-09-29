// SPDX-License-Identifier: AGPL-3.0-or-later
import { pathToFileURL } from "node:url";
import type { ClientHttp2Session } from "node:http2";
import {
  AGENT_ORIGIN_ENV,
  CLIENT_HEARTBEAT_MS,
  CURSOR_AGENT_ORIGIN,
  DEFAULT_FIRST_TOKEN_MS,
  DEFAULT_IDLE_MS,
  DEFAULT_TOOLUSE_WATCHDOG_MS,
  MAX_LOCAL_TOOL_REJECTIONS,
  LOCAL_TOOL_ESCALATE_AFTER,
  MAX_MCP_RESULT_CHARS,
  MCP_BURST_MS,
} from "../constants.ts";
import { driftError, LOCAL_TOOL_LOOP_MESSAGE, localError, networkError, staleRemoteError } from "../errors.ts";
import {
  decodeAgentServerMessage,
  encodeClientHeartbeat,
  encodeExecClientMessage,
  encodeExecStreamClose,
  encodeExecHeartbeat,
  encodeExecThrow,
  encodeInteractionResponse,
  encodeKvGetResult,
  encodeKvSetResult,
  encodeMcpSuccess,
  encodeMcpToolNotFound,
  encodeRequestContextSuccess,
  type DecodedExec,
  type McpToolWire,
} from "../proto/agent.ts";
import type { InferenceIR, IrEvent } from "../session/ir.ts";
import { estimateTokens, truncateHistory } from "../session/request.ts";
import { openConnectBidi, type BidiHooks, type ConnectBidi } from "../transport/bidi.ts";
import { debugLog } from "../transport/debug.ts";
import { agentRequestHeaders } from "../transport/headers.ts";
import { assertAllowedOrigin } from "../transport/origin.ts";
import type { BlobStore } from "./blob-store.ts";
import {
  askQuestionError,
  bestCommandTool,
  createPlanError,
  cursorMcpToolName,
  decideExec,
  interactionApprove,
  interactionRejectString,
  rankAlternatives,
  setupVmAck,
  stripCursorMcpToolName,
  unknownExecThrowMessage,
} from "./policy.ts";
import { decodeIrImage } from "./images.ts";
import {
  decodeNativeArgs,
  encodeNativeResultFromPi,
  logNativeExec,
  nativeExecMode,
  translateNativeToPi,
  tryNativeExecInproc,
  type NativeArgs,
} from "./native.ts";
import { buildAgentRequest } from "./request.ts";
import { trailingToolResults, splitCurrentUser } from "./root-prompt.ts";
import type { ConversationHandle } from "./handle-store.ts";
import {
  decideResume,
  dropHandle,
  fingerprintAfterTurn,
  remoteLooksStale,
  saveHandle,
  toolsetKeyOf,
} from "./handle-store.ts";

export interface PendingMcp {
  id: number;
  execId: string;
  toolCallId: string;
  toolName: string;
  /** Set when this pending came from a native exec translated to a Pi tool
   * call: the continuation encodes the native success/error shape, not an
   * MCP result (PROTOCOL-AGENT §5.1). */
  native?: NativeArgs;
}

interface ActiveRun {
  sessionId: string;
  conversationId: string;
  ir: InferenceIR;
  resuming: boolean;
  checkpoint: Uint8Array | undefined;
  /** True only when THIS run received a checkpoint frame. A resumed run pre-fills
   * `checkpoint` from the handle; persisting that stale checkpoint under a fresh
   * fingerprint would silently drop the turn on the next resume. */
  checkpointFresh: boolean;
  bidi: ConnectBidi;
  blob: BlobStore;
  tools: McpToolWire[];
  workspaceUri: string;
  pending: PendingMcp[];
  events: IrEvent[];
  outputTokens: number;
  localRejections: number;
  turnEnded: boolean;
  closed: boolean;
  heartbeat: ReturnType<typeof setInterval> | undefined;
  burst: ReturnType<typeof setTimeout> | undefined;
  workIdle: ReturnType<typeof setTimeout> | undefined;
  firstTimer: ReturnType<typeof setTimeout> | undefined;
  /** Failsafe while parked on a toolUse yield; Pi normally clears it by continuing. */
  watchdog: ReturnType<typeof setTimeout> | undefined;
  /** Per-exec heartbeat while a translated native exec is parked on Pi (3 s). */
  execHeartbeat: ReturnType<typeof setInterval> | undefined;
  abortListener: { signal: AbortSignal; listener: () => void } | undefined;
  sawWork: boolean;
  yieldTurn?: (events: IrEvent[]) => void;
  failTurn?: (err: unknown) => void;
  yielded: boolean;
  /** Live per-frame fan-out (streaming). Updated when a later streamSimple call continues this run. */
  emit?: (event: IrEvent) => void;
}

const runs = new Map<string, ActiveRun>();

export function agentOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[AGENT_ORIGIN_ENV]?.trim();
  return assertAllowedOrigin(raw && raw !== "" ? raw : CURSOR_AGENT_ORIGIN).origin;
}

function toolNames(tools: ReadonlyArray<{ name: string }>): string[] {
  return tools.map((t) => t.name);
}

function truncateToolText(text: string): string {
  if (text.length <= MAX_MCP_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_MCP_RESULT_CHARS)}\n\n[pi-cursor-provider truncated this tool result.]`;
}

/** Append to the turn log and fan out live. The log is the resolved `events` payload; the fan-out is streaming. */
function pushEvent(run: ActiveRun, event: IrEvent): void {
  run.events.push(event);
  run.emit?.(event);
}

function finishEvents(
  run: ActiveRun,
  stopReason: "stop" | "toolUse" | "length" | "error",
  errorMessage?: string,
): IrEvent[] {
  const usage: IrEvent = {
    type: "usage",
    // AgentService never reports input tokens; report a chars/4 estimate of the
    // serialized prompt (same heuristic Pi itself uses) so Pi's context-window
    // accounting and auto-compaction see the real prompt size, not just output.
    input: estimateTokens(run.ir),
    output: run.outputTokens,
    cacheRead: 0,
    cacheWrite: 0,
  };
  const events = [...run.events, usage];
  run.emit?.(usage);
  if (!run.events.some((e) => e.type === "done")) {
    const done: IrEvent = { type: "done", stopReason, ...(errorMessage ? { errorMessage } : {}) };
    events.push(done);
    run.emit?.(done);
  }
  return events;
}

function yieldNow(run: ActiveRun, stopReason: "stop" | "toolUse" | "error", errorMessage?: string): void {
  if (run.yielded) return;
  run.yielded = true;
  if (run.burst) {
    clearTimeout(run.burst);
    run.burst = undefined;
  }
  if (run.workIdle) {
    clearTimeout(run.workIdle);
    run.workIdle = undefined;
  }
  if (run.firstTimer) {
    clearTimeout(run.firstTimer);
    run.firstTimer = undefined;
  }
  if (stopReason === "toolUse") {
    // No other timer is armed while Pi executes the tool; without this watchdog a
    // Pi-side crash would leak the bidi stream and heartbeat forever.
    if (run.watchdog) clearTimeout(run.watchdog);
    run.watchdog = setTimeout(() => {
      debugLog({ event: "agent-tooluse-watchdog", sessionId: run.sessionId, pending: run.pending.length });
      destroyRun(run);
    }, envMs("CURSOR_PROVIDER_TOOLUSE_WATCHDOG_MS", DEFAULT_TOOLUSE_WATCHDOG_MS));
    run.watchdog.unref();
  }
  run.yieldTurn?.(finishEvents(run, stopReason, errorMessage));
}

function detachAbort(run: ActiveRun): void {
  run.abortListener?.signal.removeEventListener("abort", run.abortListener.listener);
  run.abortListener = undefined;
}

function attachAbort(run: ActiveRun, signal: AbortSignal | undefined): void {
  detachAbort(run);
  if (!signal) return;
  if (signal.aborted) {
    destroyRun(run);
    return;
  }
  const listener = (): void => {
    destroyRun(run);
  };
  signal.addEventListener("abort", listener, { once: true });
  run.abortListener = { signal, listener };
}

function destroyRun(run: ActiveRun): void {
  debugLog({ event: "agent-destroy", sessionId: run.sessionId, pending: run.pending.length });
  if (run.heartbeat) clearInterval(run.heartbeat);
  run.heartbeat = undefined;
  if (run.execHeartbeat) clearInterval(run.execHeartbeat);
  run.execHeartbeat = undefined;
  if (run.burst) clearTimeout(run.burst);
  if (run.workIdle) clearTimeout(run.workIdle);
  if (run.firstTimer) clearTimeout(run.firstTimer);
  if (run.watchdog) {
    clearTimeout(run.watchdog);
    run.watchdog = undefined;
  }
  detachAbort(run);
  run.closed = true;
  runs.delete(run.sessionId);
  try {
    run.bidi.destroy();
  } catch {
    /* ignore */
  }
  // Wake a continuation still waiting on this run (e.g. abort mid-toolUse);
  // after a settled turn this reject is a no-op.
  run.failTurn?.(new DOMException("Aborted", "AbortError"));
}

function persistRemoteHandle(run: ActiveRun): void {
  if (!run.checkpoint || run.pending.length > 0) return;
  if (!run.checkpointFresh) {
    // A resumed turn that ended without a new checkpoint frame must not persist the
    // old checkpoint under a new fingerprint: the next resume would match locally
    // while the remote conversation still sits one turn behind, silently dropping
    // this turn. Keep the previous handle; a later turn rebuilds instead.
    debugLog({ event: "agent-handle-skip", reason: "no_fresh_checkpoint", sessionId: run.sessionId });
    return;
  }
  saveHandle(run.sessionId, {
    conversationId: run.conversationId,
    checkpoint: run.checkpoint,
    fingerprint: fingerprintAfterTurn(run.ir.messages, run.events),
    blobs: run.blob.snapshot(),
    toolsetKey: toolsetKeyOf(run.tools),
  });
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function stall(run: ActiveRun, message: string): void {
  if (run.yielded) return;
  const err = networkError(message);
  run.failTurn?.(err);
  destroyRun(run);
}

function touchWork(run: ActiveRun): void {
  run.sawWork = true;
  if (run.firstTimer) {
    clearTimeout(run.firstTimer);
    run.firstTimer = undefined;
  }
  if (run.workIdle) clearTimeout(run.workIdle);
  run.workIdle = setTimeout(
    () => stall(run, "Cursor AgentService made no progress (heartbeat-only stall)"),
    envMs("CURSOR_PROVIDER_IDLE_MS", DEFAULT_IDLE_MS),
  );
}

function isLiveContinuation(ir: InferenceIR, run: ActiveRun): boolean {
  if (run.closed || run.pending.length === 0) return false;
  const last = ir.messages[ir.messages.length - 1];
  if (last?.role === "user") return false;
  const results = trailingToolResults(ir);
  // At least one pending answered: a partial batch still continues the run —
  // the unanswered pendings are re-yielded as a second toolUse batch (late
  // parallel lifts can land after the burst-window yield; see continueRun).
  return run.pending.some((p) => results.has(p.toolCallId));
}

function armFirstToken(run: ActiveRun): void {
  if (run.firstTimer) clearTimeout(run.firstTimer);
  run.firstTimer = setTimeout(
    () => stall(run, "Cursor AgentService first-token timed out"),
    envMs("CURSOR_PROVIDER_FIRST_TOKEN_MS", DEFAULT_FIRST_TOKEN_MS),
  );
}

/**
 * Second toolUse batch: some pendings were lifted after the first burst-window
 * yield (backend frames for parallel tool calls can arrive spread over more
 * than MCP_BURST_MS), so Pi never saw them and this continuation answered only
 * the first batch. Re-emit the unanswered pendings as tool_call events and
 * yield again — Pi executes them and continues once more. Without this the
 * unanswered execs starve and the backend stalls the turn.
 */
function continueRun(run: ActiveRun): void {
  run.localRejections = 0;
  run.sawWork = false;
  for (const pending of run.pending) {
    pushEvent(run, {
      type: "tool_call",
      id: pending.toolCallId,
      name: pending.toolName,
      arguments: {},
      complete: true,
    });
  }
  run.burst = setTimeout(() => yieldNow(run, "toolUse"), MCP_BURST_MS);
}

async function sendMcpResults(run: ActiveRun, ir: InferenceIR): Promise<void> {
  const results = trailingToolResults(ir);
  const remaining: PendingMcp[] = [];
  for (const pending of run.pending) {
    const result = results.get(pending.toolCallId);
    if (!result) {
      remaining.push(pending);
      continue;
    }
    const text = truncateToolText(result.result);
    if (pending.native) {
      // Native exec translated to a Pi tool call: answer in the native shape
      // (and close the stream for shell_stream), not as an MCP result.
      const reply = encodeNativeResultFromPi(pending.native, text, result.isError);
      logNativeExec(pending.native.case, pending.execId, reply);
      for (const frame of reply.frames) {
        await run.bidi.write(
          encodeExecClientMessage({
            id: frame.id ?? pending.id,
            execId: pending.execId,
            resultField: frame.resultField,
            resultBytes: frame.resultBytes,
          }),
        );
      }
      if (reply.closeStream) {
        await run.bidi.write(encodeExecStreamClose(pending.id));
      }
      continue;
    }
    const images = result.images.map((image) => decodeIrImage(image, "toolResult"));
    await run.bidi.write(
      encodeExecClientMessage({
        id: pending.id,
        execId: pending.execId,
        resultField: 11,
        resultBytes: encodeMcpSuccess(text, result.isError, images),
      }),
    );
  }
  run.pending = remaining;
  run.events = [];
  run.outputTokens = 0;
  run.yielded = false;
  run.localRejections = 0;
  run.sawWork = false;
  armFirstToken(run);
  debugLog({ event: "agent-mcp-continue", sessionId: run.sessionId, remaining: run.pending.length });
}

/**
 * Every request this provider refuses to serve locally (native reject, unknown exec,
 * or an MCP name the run never advertised) counts against ONE budget, so no path can
 * spin forever: the model either lifts a real Pi tool call or the turn fails closed.
 * The budget is per model turn — `sendMcpResults` resets it on every MCP lift.
 */
function noteLocalMiss(run: ActiveRun, kind: string, action: string, extra: Record<string, unknown> = {}): void {
  run.localRejections += 1;
  debugLog({
    event: "agent-local-miss",
    sessionId: run.sessionId,
    kind,
    action,
    misses: run.localRejections,
    toolCount: run.tools.length,
    pending: run.pending.length,
    ...extra,
  });
  if (run.localRejections < MAX_LOCAL_TOOL_REJECTIONS || run.pending.length > 0) return;
  const best = bestCommandTool(run.tools);
  throw localError(
    LOCAL_TOOL_LOOP_MESSAGE,
    best
      ? `call ${cursorMcpToolName(best.name)} with the command instead of Cursor native tools`
      : "call a registered Pi MCP tool instead of Cursor native tools",
  );
}

/** While a native exec is parked on a Pi tool call, keep its exec id warm the
 * way the reference client does (ExecClientHeartbeat every 3 s) so the backend
 * never times the exec out during a long Pi-side execution. */
function armExecHeartbeat(run: ActiveRun): void {
  if (run.execHeartbeat) return;
  run.execHeartbeat = setInterval(() => {
    const ids = run.pending.filter((p) => p.native !== undefined).map((p) => p.id);
    if (ids.length === 0) {
      if (run.execHeartbeat) clearInterval(run.execHeartbeat);
      run.execHeartbeat = undefined;
      return;
    }
    for (const id of ids) {
      run.bidi.write(encodeExecHeartbeat(id)).catch(() => {});
    }
  }, 3_000);
  run.execHeartbeat.unref();
}

async function handleExec(run: ActiveRun, exec: DecodedExec): Promise<void> {
  const tools = run.tools.map((t) => ({ name: t.name, description: t.description, jsonSchema: t.jsonSchema }));
  // Native exec translation (PROTOCOL-AGENT §5.1). "pi" lifts the exec to a
  // regular Pi tool call (Pi's permission system executes; the result is
  // encoded back into the native shape on continuation). "inproc" is the
  // probe-only path that executes in-process to validate the wire shapes.
  const mode = nativeExecMode();
  if (mode === "inproc") {
    const reply = await tryNativeExecInproc(exec);
    if (reply) {
      logNativeExec(exec.case, exec.execId, reply);
      pushEvent(run, {
        type: "tool_call",
        id: exec.execId || String(exec.id),
        name: `native:${exec.case}`,
        arguments: { summary: reply.summary },
        complete: true,
      });
      for (const frame of reply.frames) {
        await run.bidi.write(
          encodeExecClientMessage({ id: frame.id ?? exec.id, execId: exec.execId, resultField: frame.resultField, resultBytes: frame.resultBytes }),
        );
      }
      if (reply.closeStream) {
        await run.bidi.write(encodeExecStreamClose(exec.id));
      }
      return;
    }
  }
  if (mode === "pi") {
    let nativeArgs: NativeArgs | null = null;
    try {
      nativeArgs = decodeNativeArgs(exec);
    } catch (err) {
      // A payload we cannot decode must degrade to the policy reject, never crash the run.
      debugLog({
        event: "agent-native-decode-error",
        case: exec.case,
        execId: exec.execId,
        error: err instanceof Error ? err.message : String(err),
        payloadHex: Buffer.from(exec.payload).toString("hex").slice(0, 400),
      });
    }
    const target = nativeArgs ? translateNativeToPi(nativeArgs, tools) : null;
    if (nativeArgs && target) {
      const toolCallId = crypto.randomUUID();
      run.pending.push({ id: exec.id, execId: exec.execId, toolCallId, toolName: target.tool.name, native: nativeArgs });
      armExecHeartbeat(run);
      debugLog({
        event: "agent-exec",
        case: exec.case,
        action: "native-lift",
        execId: exec.execId,
        tool: target.tool.name,
        payloadHex: Buffer.from(exec.payload).toString("hex").slice(0, 500),
      });
      pushEvent(run, {
        type: "tool_call",
        id: toolCallId,
        name: target.tool.name,
        arguments: target.args,
        complete: true,
      });
      if (run.burst) clearTimeout(run.burst);
      run.burst = setTimeout(() => yieldNow(run, "toolUse"), MCP_BURST_MS);
      return;
    }
    // No capable Pi tool for this case: fall through to the policy reject.
  }
  // Repeated misses mean the first wording did not land; the reject text hardens.
  const escalated = run.localRejections >= LOCAL_TOOL_ESCALATE_AFTER;
  const decision = decideExec(exec, tools, escalated);
  debugLog({
    event: "agent-exec",
    case: exec.case,
    action: decision.action,
    execId: exec.execId,
    mcp: exec.mcp?.toolName ?? exec.mcp?.name,
  });
  if (decision.action === "mcp") {
    const raw = exec.mcp?.toolName || exec.mcp?.name || "";
    const name = stripCursorMcpToolName(raw);
    // The advertised mcp_tools catalog is frozen at Run open — the protocol has no
    // mid-run update (PROTOCOL-AGENT §5.1) — but Pi's tool registry may change
    // mid-run: a gate tool (web_enable & co.) registers more tools, and the next
    // continuation refreshes run.ir. Cursor forwards unregistered names straight
    // to exec, so consult the live registry view too; without it a tool enabled
    // mid-run stays uncallable for the rest of the Run (session 01a0ede5).
    const available = [...new Set([...toolNames(run.tools), ...toolNames(run.ir.tools)])];
    if (!name || !available.includes(name)) {
      noteLocalMiss(run, "mcp_not_found", "tool_not_found", { requested: name });
      await run.bidi.write(
        encodeExecClientMessage({
          id: exec.id,
          execId: exec.execId,
          resultField: 11,
          resultBytes: encodeMcpToolNotFound(name, rankAlternatives(name, available)),
        }),
      );
      return;
    }
    const toolCallId = exec.mcp?.toolCallId || crypto.randomUUID();
    run.pending.push({ id: exec.id, execId: exec.execId, toolCallId, toolName: name });
    pushEvent(run, {
      type: "tool_call",
      id: toolCallId,
      name,
      arguments: exec.mcp?.args ?? {},
      complete: true,
    });
    if (run.burst) clearTimeout(run.burst);
    run.burst = setTimeout(() => yieldNow(run, "toolUse"), MCP_BURST_MS);
    return;
  }
  if (decision.action === "context") {
    await run.bidi.write(
      encodeExecClientMessage({
        id: exec.id,
        execId: exec.execId,
        resultField: 10,
        resultBytes: encodeRequestContextSuccess(run.workspaceUri, run.tools),
      }),
    );
    return;
  }
  if (decision.action === "throw") {
    noteLocalMiss(run, exec.case, "throw", { execId: exec.execId });
    await run.bidi.write(
      encodeExecThrow(
        exec.id,
        exec.case === "unknown"
          ? unknownExecThrowMessage(String(exec.field), run.tools)
          : `Pi Cursor provider has no handler for exec case "${exec.case}". ${LOCAL_TOOL_LOOP_MESSAGE}`,
      ),
    );
    return;
  }
  noteLocalMiss(run, exec.case, decision.ack === true ? "ack" : "reject", { execId: exec.execId, escalated });
  await run.bidi.write(
    encodeExecClientMessage({
      id: exec.id,
      execId: exec.execId,
      resultField: decision.resultField,
      resultBytes: decision.resultBytes,
    }),
  );
}

async function handleQuery(run: ActiveRun, id: number, queryCase: string, field: number): Promise<void> {
  const reason = "Not available through pi-cursor-provider. Use Pi MCP tools instead.";
  if (queryCase === "webSearch" || queryCase === "exaSearch" || queryCase === "exaFetch" || queryCase === "hostedWebFetch") {
    await run.bidi.write(encodeInteractionResponse(id, field === 0 ? 2 : field, interactionApprove(1)));
    return;
  }
  if (queryCase === "switchMode") {
    await run.bidi.write(encodeInteractionResponse(id, 4, interactionRejectString(4, reason)));
    return;
  }
  if (queryCase === "askQuestion") {
    await run.bidi.write(encodeInteractionResponse(id, 3, askQuestionError(reason)));
    return;
  }
  if (queryCase === "createPlan") {
    await run.bidi.write(encodeInteractionResponse(id, 7, createPlanError(reason)));
    return;
  }
  if (queryCase === "setupVm") {
    await run.bidi.write(encodeInteractionResponse(id, 8, setupVmAck()));
    return;
  }
  throw driftError(`unsupported Cursor interaction query field ${String(field)}`);
}

async function handleFrame(run: ActiveRun, body: Uint8Array): Promise<void> {
  const msg = decodeAgentServerMessage(body);
  debugLog({
    event: "agent-frame",
    case: msg.case,
    inner: msg.case === "interactionUpdate" ? msg.inner.case : undefined,
    innerField: msg.case === "interactionUpdate" && msg.inner.case === "other" ? msg.inner.field : undefined,
    innerHex:
      msg.case === "interactionUpdate" && msg.inner.case === "other"
        ? Buffer.from(body.subarray(0, 220)).toString("hex")
        : undefined,
    exec: msg.case === "execServerMessage" ? msg.exec.case : undefined,
    execField: msg.case === "execServerMessage" ? msg.exec.field : undefined,
    execUnknownField: msg.case === "execServerMessage" ? msg.exec.unknown?.field : undefined,
    execUnknownHex:
      msg.case === "execServerMessage" && msg.exec.unknown
        ? Buffer.from(msg.exec.unknown.bytes.subarray(0, 128)).toString("hex")
        : undefined,
    execUnknownBytes: msg.case === "execServerMessage" ? msg.exec.unknown?.bytes.byteLength : undefined,
    query: msg.case === "interactionQuery" ? msg.query.case : undefined,
    queryField: msg.case === "interactionQuery" ? msg.query.field : undefined,
    kv: msg.case === "kvServerMessage" ? msg.kv.case : undefined,
    unknownField: msg.case === "unknown" ? msg.field : undefined,
    bytes: body.byteLength,
  });
  switch (msg.case) {
    case "ttft":
    case "execServerControl":
      return;
    case "checkpoint":
      run.checkpoint = msg.bytes;
      run.checkpointFresh = true;
      return;
    case "unknown":
      throw driftError(`unrecognized AgentServerMessage field ${String(msg.field)}`);
    case "interactionUpdate": {
      const inner = msg.inner;
      if (inner.case === "textDelta" && inner.text) {
        touchWork(run);
        pushEvent(run, { type: "text", delta: inner.text });
      }
      if (inner.case === "thinkingDelta" && inner.text) {
        touchWork(run);
        pushEvent(run, { type: "thinking", delta: inner.text });
      }
      if (inner.case === "tokenDelta") {
        touchWork(run);
        run.outputTokens += inner.tokens;
      }
      if (inner.case === "turnEnded") {
        touchWork(run);
        run.turnEnded = true;
        const toolUse = run.pending.length > 0;
        yieldNow(run, toolUse ? "toolUse" : "stop");
        if (toolUse) return;
        persistRemoteHandle(run);
        destroyRun(run);
      }
      return;
    }
    case "execServerMessage":
      touchWork(run);
      await handleExec(run, msg.exec);
      return;
    case "kvServerMessage": {
      touchWork(run);
      const kv = msg.kv;
      if (kv.case === "getBlobArgs") {
        const payload = kv.blobId ? run.blob.get(kv.blobId) : undefined;
        debugLog({
          event: "agent-blob-get",
          id: kv.id,
          blobIdHex: kv.blobId ? Buffer.from(kv.blobId).toString("hex") : "",
          hit: payload !== undefined,
          bytes: payload?.byteLength ?? 0,
        });
        if (!kv.blobId || payload === undefined) {
          throw run.resuming
            ? staleRemoteError("Cursor asked for a blob that is not in the local store")
            : localError(
                "Cursor asked for a blob that is not in the local store",
                "retry the turn; this provider does not persist blobs",
              );
        }
        await run.bidi.write(encodeKvGetResult(kv.id, payload));
        return;
      }
      if (kv.case === "setBlobArgs") {
        // A setBlobArgs without blob_data is a reference to an already-stored
        // blob id (dedup) — observed live after a Delete result. Ack it the
        // same as a full write; only store when data is present.
        if (kv.blobData) run.blob.put(kv.blobData);
        else debugLog({ event: "agent-kv-ref-only", sessionId: run.sessionId });
        await run.bidi.write(encodeKvSetResult(kv.id));
        return;
      }
      throw driftError("unrecognized KvServerMessage");
    }
    case "interactionQuery":
      touchWork(run);
      await handleQuery(run, msg.query.id, msg.query.case, msg.query.field);
      return;
  }
}

function startHeartbeat(run: ActiveRun): void {
  run.heartbeat = setInterval(() => {
    void run.bidi.write(encodeClientHeartbeat()).catch(() => undefined);
  }, CLIENT_HEARTBEAT_MS);
  run.heartbeat.unref();
}

export interface AgentSessionOptions {
  token: string;
  ir: InferenceIR;
  signal?: AbortSignal;
  origin?: string;
  hooks?: BidiHooks;
  connectImpl?: (authority: string | URL) => ClientHttp2Session;
  /** Live event fan-out: called once per IR event as it happens (streaming), not only at turn end. */
  onEvent?: (event: IrEvent) => void;
}

export async function runAgentSession(options: AgentSessionOptions): Promise<{ events: IrEvent[]; warning?: string }> {
  const { ir, warning } = truncateHistory(options.ir);
  if (ir.sessionId === "") throw localError("conversation_id is empty", "pass SimpleStreamOptions.sessionId");
  const existing = runs.get(ir.sessionId);

  if (existing && isLiveContinuation(ir, existing)) {
    existing.ir = ir;
    existing.failTurn = undefined;
    if (existing.watchdog) {
      clearTimeout(existing.watchdog);
      existing.watchdog = undefined;
    }
    // The continuation may carry a fresher signal than the one that opened the run.
    attachAbort(existing, options.signal);
    // The continuation call owns a fresh Pi sink; hand the live fan-out to it.
    existing.emit = options.onEvent;
    const events = await new Promise<IrEvent[]>((resolve, reject) => {
      existing.yieldTurn = resolve;
      existing.failTurn = reject;
      void (async () => {
        await sendMcpResults(existing, ir);
        if (existing.closed) return;
        if (existing.pending.length > 0) {
          // Unanswered late lifts: hand them to Pi as a second batch.
          continueRun(existing);
          return;
        }
        armFirstToken(existing);
      })().catch(reject);
    });
    return { events, warning };
  }

  if (existing) destroyRun(existing);

  const { history } = splitCurrentUser(ir);
  const decision = decideResume(ir.sessionId, history);
  debugLog({
    event: decision.resume ? "agent-resume" : "agent-rebuild",
    reason: decision.reason,
    sessionId: ir.sessionId,
  });
  try {
    return await openAgentRun(options, ir, warning, decision.resume);
  } catch (error) {
    if (!decision.resume || !remoteLooksStale(error)) throw error;
    dropHandle(ir.sessionId);
    debugLog({ event: "agent-rebuild", reason: "stale_retry", sessionId: ir.sessionId });
    // Content may already have been streamed live from the failed resume attempt;
    // tell the sink to drop it so the rebuild does not double-apply.
    options.onEvent?.({ type: "reset" });
    return await openAgentRun(options, ir, warning, undefined);
  }
}

async function openAgentRun(
  options: AgentSessionOptions,
  ir: InferenceIR,
  warning: string | undefined,
  resume: ConversationHandle | undefined,
): Promise<{ events: IrEvent[]; warning?: string }> {
  const request = buildAgentRequest(ir, undefined, resume);
  const origin = options.origin ?? agentOrigin();
  const requestId = crypto.randomUUID();
  let run: ActiveRun | undefined;

  const events = await new Promise<IrEvent[]>((resolve, reject) => {
    const bidi = openConnectBidi({
      origin,
      headers: agentRequestHeaders({ token: options.token, requestId }),
      signal: options.signal,
      hooks: options.hooks,
      connectImpl: options.connectImpl,
      onFrame: async (body) => {
        if (!run) return;
        await handleFrame(run, body);
      },
    });
    run = {
      sessionId: ir.sessionId,
      conversationId: request.conversationId,
      ir,
      resuming: resume !== undefined,
      checkpoint: resume?.checkpoint,
      checkpointFresh: false,
      bidi,
      blob: request.blobStore,
      tools: request.tools,
      workspaceUri: request.workspaceUri,
      pending: [],
      events: warning ? [{ type: "warning", message: warning }] : [],
      outputTokens: 0,
      localRejections: 0,
      turnEnded: false,
      closed: false,
      heartbeat: undefined,
      burst: undefined,
      workIdle: undefined,
      firstTimer: undefined,
      watchdog: undefined,
      execHeartbeat: undefined,
      abortListener: undefined,
      sawWork: false,
      yieldTurn: resolve,
      failTurn: reject,
      yielded: false,
      emit: options.onEvent,
    };
    runs.set(ir.sessionId, run);
    if (warning) run.emit?.({ type: "warning", message: warning });
    startHeartbeat(run);
    armFirstToken(run);
    debugLog({
      event: "agent-run",
      sessionId: ir.sessionId,
      conversationId: request.conversationId,
      origin,
      resuming: resume !== undefined,
      modelId: ir.modelId,
      maxMode: ir.maxMode,
      contextParam: ir.contextParam,
      effortParams: ir.effortParams?.map((p) => `${p.id}=${p.value}`).join(",") ?? undefined,
      toolCount: request.tools.length,
      tools: request.tools.map((t) => t.name).join(","),
    });
    void bidi.write(request.bytes).catch(reject);
    void bidi.closed.then(() => {
      if (!run) return;
      if (run.pending.length > 0) run.closed = true;
      if (run.yielded) return;
      yieldNow(run, run.pending.length > 0 ? "toolUse" : "stop");
    }, (err) => {
      if (run?.yielded) return;
      reject(err);
    });
    attachAbort(run, options.signal);
  });

  debugLog({ event: "agent-turn", sessionId: ir.sessionId, origin, cwd: pathToFileURL(process.cwd()).href });
  return { events, warning };
}

export function __resetAgentRunsForTests(): void {
  for (const run of runs.values()) destroyRun(run);
}
