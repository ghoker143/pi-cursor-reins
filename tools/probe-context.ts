// SPDX-License-Identifier: AGPL-3.0-or-later
// Probe #5: requested_model.parameters id "context". AgentService started
// rejecting it — not_found for every value (128k/256k/1m) and family (grok,
// claude), measured 2026-10-03 — fixed by dropping the parameter on the agent
// channel (src/agent/request.ts). This probe drives the production path
// (runAgentSession strips ir.contextParam), so every case must print OK;
// a FAIL means the slug itself stopped resolving, not the context parameter.
// To re-measure the raw server behavior, temporarily restore the
// ir.contextParam forwarding in src/agent/request.ts and re-run.
//
//   node --experimental-strip-types tools/probe-context.ts
import { discoverModels } from "../src/catalog/index.ts";
import { runAgentSession } from "../src/agent/index.ts";
import { loadAccess } from "./lib/fake-pi.ts";

const token = loadAccess();
const rows = await discoverModels({ token });

const families = ["grok-4.7", "claude-sonnet-5-thinking", "composer-2.5"];
for (const id of families) {
  const row = rows.find((r) => r.id === id);
  if (!row) {
    console.log(`${id}: ROW NOT FOUND`);
    continue;
  }
  const sp = (row.samplingParams ?? {}) as Record<string, unknown>;
  const slug =
    (typeof sp.cursorDefaultModelId === "string" ? sp.cursorDefaultModelId : undefined) ??
    (Object.values((row.thinkingLevelMap ?? {}) as Record<string, string>)[0] as string | undefined);
  if (!slug) {
    console.log(`${id}: no slug`);
    continue;
  }
  console.log(`-- ${id}: slug=${slug} rowCtx=${JSON.stringify(sp.cursorContext)}`);
  for (const ctx of ["256k", "1m", undefined]) {
    try {
      await runAgentSession({
        token,
        ir: {
          sessionId: `probe-ctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          modelId: slug,
          maxMode: false,
          systemPrompt: "",
          tools: [],
          messages: [{ role: "user", text: "Reply with exactly: ok" }],
          contextWindow: 128000,
          ...(ctx ? { contextParam: ctx } : {}),
        },
        hooks: {},
      });
      console.log(`   ir.contextParam=${ctx ?? "none"}: OK`);
    } catch (error) {
      console.log(`   ir.contextParam=${ctx ?? "none"}: FAIL ${(error as Error).message.split("\n")[0]?.slice(0, 70)}`);
    }
  }
}
