// Probe #4: maxMode + slug combo (the -max pi rows). Slug-only works without
// maxMode (probe #3); does it survive maxMode=true?
//
//   node --experimental-strip-types tools/probe-model-maxmode.ts
import { runAgentSession } from "../src/agent/index.ts";
import { loadAccess } from "./lib/fake-pi.ts";

const token = loadAccess();

const cases: { label: string; modelId: string; maxMode: boolean }[] = [
  { label: "grok-4.7-high + maxMode", modelId: "grok-4.7-high", maxMode: true },
  { label: "cursor-grok-4.6-high + maxMode", modelId: "cursor-grok-4.6-high", maxMode: true },
  { label: "grok-4.7 (bare) + maxMode (old shape)", modelId: "grok-4.7", maxMode: true },
  { label: "grok-4.7-high (no maxMode, baseline)", modelId: "grok-4.7-high", maxMode: false },
];

for (const c of cases) {
  try {
    const result = await runAgentSession({
      token,
      ir: {
        sessionId: `probe-max-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        modelId: c.modelId,
        maxMode: c.maxMode,
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
    console.log(`${c.label}: OK "${text.trim().slice(0, 40)}"`);
  } catch (error) {
    console.log(`${c.label}: FAIL ${(error as Error).message.split("\n")[0]?.slice(0, 90)}`);
  }
}
