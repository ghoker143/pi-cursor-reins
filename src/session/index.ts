// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MachineIdentity } from "../identity/index.ts";
import type { ClientHttp2Session } from "node:http2";
import { runInferenceStream, type StreamHooks } from "../transport/h2.ts";
import { applyServerMessage, createMapper } from "./events.ts";
import { clientInvoke, clientRunRequest, truncateHistory } from "./request.ts";
import type { InferenceIR, IrEvent } from "./ir.ts";

export interface SessionRunOptions {
  token: string;
  identity: MachineIdentity;
  ir: InferenceIR;
  signal?: AbortSignal;
  origin?: string;
  hooks?: StreamHooks;
  connectImpl?: (authority: string | URL) => ClientHttp2Session;
  createInvocationId?: () => string;
  /** Live event fan-out: called once per IR event as it happens (streaming), not only at invocation end. */
  onEvent?: (event: IrEvent) => void;
}

export async function runSession(options: SessionRunOptions): Promise<{ events: IrEvent[]; warning?: string }> {
  const { ir, warning } = truncateHistory(options.ir);
  const invocationId = (options.createInvocationId ?? (() => crypto.randomUUID()))();
  const mapper = createMapper();
  if (warning) {
    const event: IrEvent = { type: "warning", message: warning };
    mapper.events.push(event);
    options.onEvent?.(event);
  }
  await runInferenceStream({
    token: options.token,
    identity: options.identity,
    origin: options.origin,
    signal: options.signal,
    runRequest: clientRunRequest(ir),
    invoke: clientInvoke(ir, invocationId),
    hooks: options.hooks,
    connectImpl: options.connectImpl,
    onMessage: (message) => {
      const before = mapper.events.length;
      applyServerMessage(mapper, message);
      for (let i = before; i < mapper.events.length; i += 1) options.onEvent?.(mapper.events[i]!);
    },
  });
  if (!mapper.events.some((e) => e.type === "done")) {
    const event: IrEvent = {
      type: "done",
      stopReason: mapper.completedTools > 0 ? "toolUse" : mapper.stopReason,
      ...(mapper.errorMessage ? { errorMessage: mapper.errorMessage } : {}),
    };
    mapper.events.push(event);
    options.onEvent?.(event);
  }
  return { events: mapper.events, warning };
}
