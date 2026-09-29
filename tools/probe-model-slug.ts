// Probe #3: does the fix shape (level slug as model_id, with effortParams)
// work across families — grok, gpt, claude? The 2026-09-28 measurement claimed
// slugs are rejected; today's grok data says otherwise. Verify before flipping
// the send path.
//
//   node --experimental-strip-types tools/probe-model-slug.ts
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
const rows = mapCatalog(
  decodeAvailableModelsResponse(availableBytes),
  decodeGetUsableModelsResponse(usableBytes),
  decodeGetDefaultModelForCliResponse(defaultBytes),
);

// One reasoning family per vendor: grok (broken bare id), gpt, claude.
const picked = ["cursor-grok-4.6", "gpt-5.5", "claude-sonnet-5-thinking"];
for (const id of picked) {
  const row = rows.find((r) => r.id === id);
  if (!row) {
    console.log(`${id}: ROW NOT FOUND`);
    continue;
  }
  const levelMap = (row.thinkingLevelMap ?? {}) as Record<string, string | null>;
  const cursorParams = (row.samplingParams?.cursorParams ?? {}) as Record<string, { id: string; value: string }[]>;
  const level = cursorParams["high"] !== undefined || levelMap["high"] ? "high" : Object.keys(levelMap)[0]!;
  const slug = levelMap[level];
  const params = cursorParams[level];
  console.log(`-- ${id}: level=${level} slug=${slug} params=${JSON.stringify(params)}`);
  if (!slug) continue;
  const cases = [
    { label: "slug only", modelId: slug, params: undefined },
    { label: "slug + effortParams", modelId: slug, params },
    { label: "family + effortParams (prod today)", modelId: row.id, params },
  ];
  for (const c of cases) {
    try {
      const result = await runAgentSession({
        token,
        ir: {
          sessionId: `probe-slug-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          modelId: c.modelId,
          maxMode: false,
          systemPrompt: "",
          tools: [],
          messages: [{ role: "user", text: "Reply with exactly: ok" }],
          contextWindow: 128000,
          ...(c.params ? { effortParams: c.params } : {}),
        },
        hooks: {},
      });
      const text = result.events
        .filter((e) => e.type === "text")
        .map((e) => (e as { delta: string }).delta)
        .join("");
      console.log(`   ${c.label}: OK "${text.trim().slice(0, 30)}"`);
    } catch (error) {
      console.log(`   ${c.label}: FAIL ${(error as Error).message.split("\n")[0]?.slice(0, 70)}`);
    }
  }
}
