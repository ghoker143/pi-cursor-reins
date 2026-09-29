// Probe: why do `cursor-grok-4.6` / `grok-4.7` appear side by side, and which
// model ids does AgentService actually accept (the `not_found` report)?
//
//   node --experimental-strip-types tools/probe-models.ts
//
// 1. Dumps the raw GetUsableModels ids and how mapCatalog groups them.
// 2. Sends a minimal AgentService Run per grok-flavored candidate id and
//    reports which succeed vs fail with not_found.
import { unary } from "../src/transport/unary.ts";
import {
  decodeAvailableModelsResponse,
  decodeGetUsableModelsResponse,
  decodeGetDefaultModelForCliResponse,
  encodeAvailableModelsRequest,
  encodeEmpty,
} from "../src/proto/catalog.ts";
import { mapCatalog } from "../src/catalog/index.ts";
import { runAgentSession } from "../src/agent/index.ts";
import { loadAccess } from "./lib/fake-pi.ts";

const token = loadAccess();

const [availableBytes, usableBytes, defaultBytes] = await Promise.all([
  unary({ token, method: "AvailableModels", body: encodeAvailableModelsRequest() }),
  unary({ token, method: "GetUsableModels", body: encodeEmpty() }),
  unary({ token, method: "GetDefaultModelForCli", body: encodeEmpty() }),
]);
const available = decodeAvailableModelsResponse(availableBytes);
const usable = decodeGetUsableModelsResponse(usableBytes);
const fallbackDefault = decodeGetDefaultModelForCliResponse(defaultBytes);

console.log("== raw usable model ids ==");
for (const m of usable.models) console.log(" ", m.modelId || "(empty)");

const rows = mapCatalog(available, usable, fallbackDefault);
console.log("\n== mapped pi rows (id | name | thinkingLevelMap) ==");
for (const r of rows) {
  console.log(` ${r.id} | ${r.name} | ${JSON.stringify(r.thinkingLevelMap ?? {})} | default=${r.samplingParams?.["cursorDefaultModelId"] ?? "-"}`);
}

// Candidates: every grok-flavored raw id plus de-prefixed variants.
if (process.env.SKIP_RUNS === "1") {
  console.log("\n(SKIP_RUNS=1 — catalog dump only)");
  process.exit(0);
}
const grokRaw = usable.models.map((m) => m.modelId).filter((id) => id.includes("grok"));
const candidates = [...new Set([...grokRaw, ...grokRaw.map((id) => id.replace(/^cursor-/, ""))])];
console.log("\n== AgentService Run per candidate ==");
for (const id of candidates) {
  try {
    const result = await runAgentSession({
      token,
      ir: {
        sessionId: `probe-model-${id}-${Date.now()}`,
        modelId: id,
        maxMode: false,
        systemPrompt: "",
        tools: [],
        messages: [{ role: "user", text: "Reply with exactly: ok" }],
        contextWindow: 128000,
      },
      hooks: {},
    });
    const text = result.events
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    console.log(` ${id}: OK "${text.trim().slice(0, 40)}"`);
  } catch (error) {
    console.log(` ${id}: FAIL ${(error as Error).message.split("\n")[0]?.slice(0, 80)}`);
  }
}
