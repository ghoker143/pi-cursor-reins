// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Contract-via-rules probe: can the model correctly call an MCP tool it has
 * NEVER seen described, guided only by a compact contract in the client rules?
 *
 *   node --experimental-strip-types tools/probe-contract.ts
 *
 * The tool is registered in mcp_tools (so CallDynamicTool works server-side),
 * but per probe-fidelity its description/schema never reach the model. The
 * only guidance is the compact contract the provider composes into the rules.
 * Pass = the lifted tool_call carries the right name and the right argument
 * shape.
 */
const { runAgentSession } = await import("../src/agent/index.ts");
const { loadAccess } = await import("./lib/fake-pi.ts");
import type { IrMessage } from "../src/session/ir.ts";

const token = loadAccess();
const sessionId = crypto.randomUUID();
const modelId = process.env.PROBE_MODEL ?? "grok-4.7";

const TOOL = {
  name: "roll_dice",
  description: "Roll dice and return the total.",
  jsonSchema: {
    type: "object",
    properties: { sides: { type: "number" }, count: { type: "number" } },
    required: ["sides", "count"],
  },
};

/** ask_user_question-shaped: nested array of objects — the hardest argument
 * shape the contract must convey. */
const COMPLEX_TOOL = {
  name: "ask_questions",
  description: "Ask the user structured questions.",
  jsonSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            header: { type: "string" },
            options: {
              type: "array",
              items: {
                type: "object",
                properties: { label: { type: "string" }, description: { type: "string" } },
                required: ["label"],
              },
            },
          },
          required: ["question", "header", "options"],
        },
      },
    },
    required: ["questions"],
  },
};

const RULES = "You are a helpful coding assistant."; // no tool guidance: the provider composes the contract

const complex = process.argv[2] === "complex";
const tool = complex ? COMPLEX_TOOL : TOOL;
const messages: IrMessage[] = [
  {
    role: "user",
    text: complex
      ? 'Use the pi tool for structured questions to ask me exactly one question: header "Lunch", question "Rice or noodles?", options "Rice" (a staple) and "Noodles" (also a staple).'
      : "Roll three 20-sided dice using the pi tool for that, and tell me the total.",
  },
];

const result = await runAgentSession({
  token,
  ir: { sessionId, systemPrompt: RULES, messages, tools: [tool], modelId, maxMode: false, contextWindow: 200_000 },
  hooks: {},
});

let text = "";
let call: { name: string; arguments?: Record<string, unknown> } | undefined;
for (const e of result.events) {
  if (e.type === "text") text += e.delta;
  if (e.type === "tool_call" && !call) call = { name: e.name, arguments: e.arguments ?? {} };
}

const q0 = complex
  ? (call?.arguments?.questions as Record<string, unknown>[] | undefined)?.[0]
  : undefined;
const argsOk = complex
  ? call?.name === "ask_questions" &&
    Array.isArray(call?.arguments?.questions) &&
    (call.arguments?.questions as unknown[]).length === 1 &&
    q0?.header === "Lunch" &&
    Array.isArray(q0?.options) &&
    (q0.options as unknown[]).length === 2
  : call?.name === "roll_dice" &&
    Number(call.arguments?.sides) === 20 &&
    Number(call.arguments?.count) === 3;

console.log(
  JSON.stringify(
    { ok: argsOk, model: modelId, call: call ?? null, text: call ? undefined : text.slice(0, 300) },
    null,
    1,
  ),
);
process.exitCode = argsOk ? 0 : 1;
