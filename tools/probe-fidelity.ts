// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Fidelity probe: does the model actually receive (a) our MCP tool
 * descriptions/schemas, (b) our client rules — verbatim?
 *
 *   node --experimental-strip-types tools/probe-fidelity.ts
 *
 * Method: embed unique markers in every tool description and in the client
 * rules, then ask the model to quote them back. Any mangling, truncation, or
 * server-side downgrade shows up as a missing/altered marker.
 */
const { runAgentSession } = await import("../src/agent/index.ts");
const { loadAccess } = await import("./lib/fake-pi.ts");
import type { IrMessage } from "../src/session/ir.ts";

const token = loadAccess();
const sessionId = crypto.randomUUID();
const modelId = process.env.PROBE_MODEL ?? "grok-4.7";

const TOOLS = [
  {
    name: "bash",
    description: "MARKER_DESC_BASH_Q7X: run exactly one POSIX shell command through Pi and return its combined stdout+stderr verbatim",
    jsonSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "MARKER_PARAM_CMD_Z3: the exact command line" },
        timeout: { type: "number", description: "MARKER_PARAM_TIMEOUT_W8: seconds" },
      },
      required: ["command"],
    },
  },
  {
    name: "read",
    description: "MARKER_DESC_READ_K2M: read a UTF-8 text file and return numbered lines",
    jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

const RULES =
  "MARKER_RULES_P4N: You are running inside the pi coding agent. When you need local file or shell operations, prefer your built-in tools; the MCP tools in namespace pi are equivalent alternatives.";

const QUESTION = [
  "I am debugging a tool-integration. Answer exactly, quoting verbatim where asked:",
  '1. Quote the full description of the tool "mcp_pi_bash" (namespace pi) character for character. If you cannot see any description, say NO-DESCRIPTION.',
  '2. List the parameters of "mcp_pi_bash" with their types and any per-parameter descriptions you can see.',
  '3. Quote any instructions/rules text you received from the client application (not your built-in configuration). If none, say NO-RULES.',
  "4. Does your built-in Shell tool's own description mention a timeout parameter? Yes or no.",
].join("\n");

const messages: IrMessage[] = [{ role: "user", text: QUESTION }];

async function ask(tag: string): Promise<void> {
  const result = await runAgentSession({
    token,
    ir: { sessionId, systemPrompt: RULES, messages, tools: TOOLS, modelId, maxMode: false, contextWindow: 200_000 },
    hooks: {},
  });
  let text = "";
  for (const e of result.events) if (e.type === "text") text += e.delta;
  console.log(`\n===== ${tag} =====\n${text}`);
  console.log(`\n----- marker check (${tag}) -----`);
  for (const marker of ["MARKER_DESC_BASH_Q7X", "MARKER_PARAM_CMD_Z3", "MARKER_PARAM_TIMEOUT_W8", "MARKER_DESC_READ_K2M", "MARKER_RULES_P4N"]) {
    console.log(`${text.includes(marker) ? "PRESENT" : "ABSENT "}  ${marker}`);
  }
}

await ask("FRESH");
messages.push({ role: "user", text: "Same four questions again, on this resumed turn." });
// (the assistant reply is server-side via checkpoint; no local history replay needed)
await ask("RESUME");
