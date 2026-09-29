// Probe #2: the exact model_ids production sends (bare family ids from
// mapCatalog row ids) and the production shape (family id + effortParams).
//
//   node --experimental-strip-types tools/probe-model-family.ts
import { runAgentSession } from "../src/agent/index.ts";
import { loadAccess } from "./lib/fake-pi.ts";

const token = loadAccess();

const cases: { label: string; modelId: string; effortParams?: { id: string; value: string }[] }[] = [
  // Bare family ids = pi row ids (compat/index.ts sends them verbatim).
  { label: "bare cursor-grok-4.6", modelId: "cursor-grok-4.6" },
  { label: "bare cursor-grok-4.6-fast", modelId: "cursor-grok-4.6-fast" },
  { label: "bare grok-4.7", modelId: "grok-4.7" },
  { label: "bare grok-4.7-fast", modelId: "grok-4.7-fast" },
  { label: "bare cursor-grok-4.5", modelId: "cursor-grok-4.5" },
  { label: "bare cursor-grok-4.5-fast", modelId: "cursor-grok-4.5-fast" },
  // Production shape today: family id + variant effort parameter.
  {
    label: "cursor-grok-4.6 + effort=high",
    modelId: "cursor-grok-4.6",
    effortParams: [{ id: "reasoning_effort", value: "high" }],
  },
  {
    label: "cursor-grok-4.6-fast + effort=high",
    modelId: "cursor-grok-4.6-fast",
    effortParams: [{ id: "reasoning_effort", value: "high" }],
  },
  // Alternative: level slug as model_id (id the backend actually publishes).
  { label: "slug cursor-grok-4.6-high-fast", modelId: "cursor-grok-4.6-high-fast" },
];

for (const c of cases) {
  try {
    const result = await runAgentSession({
      token,
      ir: {
        sessionId: `probe-fam-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        modelId: c.modelId,
        maxMode: false,
        systemPrompt: "",
        tools: [],
        messages: [{ role: "user", text: "Reply with exactly: ok" }],
        contextWindow: 128000,
        ...(c.effortParams ? { effortParams: c.effortParams } : {}),
      },
      hooks: {},
    });
    const text = result.events
      .filter((e) => e.type === "text")
      .map((e) => (e as { delta: string }).delta)
      .join("");
    console.log(`${c.label}: OK "${text.trim().slice(0, 40)}"`);
  } catch (error) {
    console.log(`${c.label}: FAIL ${(error as Error).message.split("\n")[0]?.slice(0, 90)}`);
  }
}
