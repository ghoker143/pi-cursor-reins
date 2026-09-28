// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live AgentService/Run probe. Prints HTTP/error kind only — never tokens.
 *
 *   node --experimental-strip-types tools/probe-agent.ts
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runAgentSession } from "../src/agent/index.ts";

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
let status = 0;
const kinds: string[] = [];

try {
  const result = await runAgentSession({
    token,
    ir: {
      sessionId: crypto.randomUUID(),
      systemPrompt: "Reply with a single word.",
      messages: [{ role: "user", text: "Reply with the single word pong." }],
      tools: [],
      modelId: "composer-2.5",
      maxMode: false,
      contextWindow: 200_000,
    },
    hooks: {
      onResponse: (s) => {
        status = s;
      },
    },
  });
  for (const event of result.events) kinds.push(event.type);
  const text = result.events
    .filter((e) => e.type === "text")
    .map((e) => (e.type === "text" ? e.delta : ""))
    .join("");
  console.log(JSON.stringify({ ok: true, http: status, frames: kinds, text: text.slice(0, 80) }));
} catch (error) {
  const err = error as { kind?: string; message?: string };
  console.log(
    JSON.stringify({
      ok: false,
      http: status,
      kind: err.kind ?? "unknown",
      message: err.message ?? String(error),
      frames: kinds,
    }),
  );
  process.exitCode = 1;
}
