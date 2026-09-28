// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live U1 probe: does this account's credential actually reach RunInference?
 * Prints HTTP/error kind only — never tokens.
 *
 *   node --experimental-strip-types tools/probe-runinference.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadMachineIdentity } from "../src/identity/index.ts";
import { runInferenceStream } from "../src/transport/h2.ts";
import { InferenceMessageRole } from "../src/proto/inference.ts";

function loadAccess(): string {
  const env = process.env.PI_CURSOR_TOKEN;
  if (env && env !== "") return env;
  const candidates = [
    join(homedir(), ".pi/agent/auth.json"),
    join(homedir(), ".config/pi/agent/auth.json"),
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "pi/agent/auth.json"),
  ];
  for (const path of candidates) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { cursor?: { access?: string } };
      if (raw.cursor?.access) return raw.cursor.access;
    } catch {
      /* try next */
    }
  }
  throw new Error("no cursor credential (run /login cursor)");
}

const token = loadAccess();
const identity = loadMachineIdentity();
const sessionId = crypto.randomUUID();
const invocationId = crypto.randomUUID();
let status = 0;
let cases: string[] = [];

try {
  await runInferenceStream({
    token,
    identity,
    runReadyMs: 20_000,
    firstTokenMs: 20_000,
    idleMs: 20_000,
    hooks: {
      onResponse: (s) => {
        status = s;
      },
    },
    runRequest: {
      case: "runRequest",
      value: {
        conversationId: sessionId,
        requestedModel: { modelId: "composer-2.5" },
        routingConversation: [{ role: 1, text: "ping" }],
        agentMode: "agent",
      },
    },
    invoke: {
      case: "invokeModel",
      invocationId,
      request: {
        messages: [
          { role: InferenceMessageRole.USER, text: "Reply with the single word pong." },
        ],
        tools: [],
        conversationId: sessionId,
        invocationId,
        requestedModel: { modelId: "composer-2.5" },
      },
    },
    onMessage: (m) => {
      cases.push(m.case);
    },
  });
  console.log(JSON.stringify({ ok: true, http: status, frames: cases }));
} catch (error) {
  const err = error as { kind?: string; message?: string };
  console.log(
    JSON.stringify({
      ok: false,
      http: status,
      kind: err.kind ?? "unknown",
      message: err.message ?? String(error),
      frames: cases,
    }),
  );
  process.exitCode = 1;
}
