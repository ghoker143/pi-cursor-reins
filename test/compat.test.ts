// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyIrEvent, emptyAssistant, transcriptToIr } from "../src/compat/index.ts";
import type { Model, TranscriptContext } from "@earendil-works/pi-ai";

const model: Model<string> = {
  id: "composer-2.5",
  name: "Composer 2.5",
  api: "cursor-provider",
  provider: "cursor",
  baseUrl: "https://api2.cursor.sh",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 64000,
};

const vision: Model<string> = { ...model, input: ["text", "image"] };

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function ctx(messages: TranscriptContext["messages"]): TranscriptContext {
  return { messages } as TranscriptContext;
}

test("T-COMPAT: the thinking level becomes a Cursor variant parameter", () => {const reasoned = {
    ...model,
    reasoning: true,
    samplingParams: {
      cursorParams: {
        low: [{ id: "reasoning_effort", value: "low" }],
        high: [{ id: "reasoning_effort", value: "high" }],
      },
    },
  } as Model<string>;
  const messages = [{ role: "user", content: "hi", timestamp: 1 }] as TranscriptContext["messages"];
  const at = (reasoning?: string) =>
    transcriptToIr(ctx(messages), reasoned, { sessionId: "s", ...(reasoning ? { reasoning } : {}) } as never);
  assert.deepEqual(at("high").effortParams, [{ id: "reasoning_effort", value: "high" }]);
  assert.equal(at("high").modelId, "composer-2.5", "the requested model id stays the base id");
  assert.equal(at(undefined).effortParams, undefined, "no level selected sends no effort parameter");
  assert.equal(at("max").effortParams, undefined, "a level this family has no variant for sends nothing");
  // A request-level override must win, exactly like cursorMaxMode/cursorContext.
  const viaOptions = transcriptToIr(ctx(messages), { ...model, reasoning: true } as Model<string>, {
    sessionId: "s",
    reasoning: "low",
    samplingParams: { cursorParams: { low: [{ id: "effort", value: "low" }] } },
  } as never);
  assert.deepEqual(viaOptions.effortParams, [{ id: "effort", value: "low" }]);
});

test("T-COMPAT: catalog-carrying rows send the published level slug as model_id", () => {
  // Measured 2026-09-29: AgentService accepts published GetUsableModels slugs for
  // every family, rejects constructed family ids (bare `cursor-grok-4.6`, all
  // `-fast` family ids), and rejects slug + effortParams combos. So a row with
  // catalog data sends the slug alone.
  const grok = {
    ...model,
    id: "grok-4.6",
    reasoning: true,
    thinkingLevelMap: {
      low: "cursor-grok-4.6-low",
      medium: "cursor-grok-4.6-medium",
      high: "cursor-grok-4.6-high",
    },
    samplingParams: {
      cursorDefaultModelId: "cursor-grok-4.6-medium",
      cursorParams: { high: [{ id: "effort", value: "high" }] },
    },
  } as unknown as Model<string>;
  const messages = [{ role: "user", content: "hi", timestamp: 1 }] as TranscriptContext["messages"];
  const at = (reasoning?: string) =>
    transcriptToIr(ctx(messages), grok, { sessionId: "s", ...(reasoning ? { reasoning } : {}) } as never);
  assert.equal(at("high").modelId, "cursor-grok-4.6-high", "the selected level's published slug");
  assert.equal(at("high").effortParams, undefined, "the slug already encodes the variant");
  assert.equal(at(undefined).modelId, "cursor-grok-4.6-medium", "no level → backend-marked default slug");
  assert.equal(at("max").modelId, "cursor-grok-4.6-medium", "unmapped level → default slug, not family id");

  const noDefault = {
    ...grok,
    samplingParams: {},
    thinkingLevelMap: { off: "composer-2.5" },
  } as unknown as Model<string>;
  const irOff = transcriptToIr(ctx(messages), noDefault, { sessionId: "s" } as never);
  assert.equal(irOff.modelId, "composer-2.5", "no default slug → the off level's published id");
});

test("T-COMPAT: pi 0.87 system+tools live on system messages", () => {
  const ir = transcriptToIr(
    ctx([
      {
        role: "system",
        content: "You are helpful.",
        toolsAdded: [
          {
            name: "echo",
            description: "echo",
            parameters: { type: "object", properties: { q: { type: "string" } } } as never,
          },
        ],
        timestamp: 1,
      },
      { role: "user", content: "hi", timestamp: 2 },
    ]),
    model,
    { sessionId: "sess-1" },
  );
  assert.equal(ir.systemPrompt, "You are helpful.");
  assert.equal(ir.tools[0]?.name, "echo");
  assert.equal(ir.sessionId, "sess-1");
  assert.equal(ir.messages[0]?.role, "user");
});

test("T-COMPAT: reset event clears streamed content for a clean retry", () => {
  const output = emptyAssistant(model);
  const pushed: string[] = [];
  const sink = { push: (e: unknown) => pushed.push((e as { type: string }).type), output };
  applyIrEvent(sink, { type: "text", delta: "stale " });
  applyIrEvent(sink, { type: "reset" });
  applyIrEvent(sink, { type: "text", delta: "fresh" });
  const texts = output.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text);
  assert.deepEqual(texts, ["fresh"]);
  assert.ok(!pushed.includes("reset"), "reset is sink-internal, never pushed to the Pi stream");
});

test("T-COMPAT: image parts lift even when the persisted model row is text-only", () => {
  const ir = transcriptToIr(
    ctx([
      { role: "system", content: "", timestamp: 1 },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", data: PNG_1X1, mimeType: "image/png" },
        ],
        timestamp: 2,
      },
    ]),
    model,
  );
  assert.equal(ir.messages[0]?.images?.[0]?.mimeType, "image/png");
});

test("T-COMPAT: image parts lift into IR for vision models", () => {
  const ir = transcriptToIr(
    ctx([
      { role: "system", content: "", timestamp: 1 },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image", data: PNG_1X1, mimeType: "image/png" },
        ],
        timestamp: 2,
      },
    ]),
    vision,
  );
  assert.equal(ir.messages[0]?.text, "look");
  assert.equal(ir.messages[0]?.images?.[0]?.mimeType, "image/png");
  assert.equal(ir.messages[0]?.images?.[0]?.data, PNG_1X1);
});

test("T-COMPAT: toolResult images lift even when the persisted model row is text-only", () => {
  const ir = transcriptToIr(
    ctx([
      { role: "system", content: "", timestamp: 1 },
      { role: "user", content: "go", timestamp: 2 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_9", name: "read", arguments: { path: "a.png" } }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 3,
      },
      {
        role: "toolResult",
        toolCallId: "call_9",
        toolName: "read",
        content: [
          { type: "text", text: "Read image file [image/png]" },
          { type: "image", data: PNG_1X1, mimeType: "image/png" },
        ],
        isError: false,
        timestamp: 4,
      },
    ]),
    model,
  );
  assert.equal(ir.messages[2]?.toolResult?.images?.[0]?.mimeType, "image/png");
});

test("T-COMPAT: IR events map to balanced pi text events", () => {
  const output = emptyAssistant(model);
  const events: { type: string }[] = [];
  const sink = { output, push: (e: unknown) => events.push(e as { type: string }) };
  applyIrEvent(sink, { type: "text", delta: "Hel" });
  applyIrEvent(sink, { type: "text", delta: "lo", final: true });
  assert.deepEqual(
    events.map((e) => e.type),
    ["text_start", "text_delta", "text_delta", "text_end"],
  );
  assert.equal(output.content[0] && output.content[0].type === "text" ? output.content[0].text : "", "Hello");
});

test("T-COMPAT: toolResult keeps server tool_call_id", () => {
  const ir = transcriptToIr(
    ctx([
      { role: "system", content: "", timestamp: 1 },
      { role: "user", content: "go", timestamp: 2 },
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_9", name: "echo", arguments: { q: "1" } }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 3,
      },
      {
        role: "toolResult",
        toolCallId: "call_9",
        toolName: "echo",
        content: [{ type: "text", text: "1" }],
        isError: false,
        timestamp: 4,
      },
    ]),
    model,
  );
  assert.equal(ir.messages[1]?.toolCalls?.[0]?.id, "call_9");
  assert.equal(ir.messages[2]?.toolResult?.toolCallId, "call_9");
});

test("T-COMPAT: is_final closes a text block; interleaved text opens new blocks", () => {
  const output = emptyAssistant(model);
  const sink = { push: () => undefined, output };
  applyIrEvent(sink, { type: "text", delta: "first", final: true });
  applyIrEvent(sink, { type: "tool_call", id: "c1", name: "echo", arguments: {}, complete: true });
  applyIrEvent(sink, { type: "text", delta: "second" });
  assert.deepEqual(
    output.content.map((c) => c.type),
    ["text", "toolCall", "text"],
    "text after a tool call must not merge into the historical block",
  );
  const texts = output.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text);
  assert.deepEqual(texts, ["first", "second"]);
});
