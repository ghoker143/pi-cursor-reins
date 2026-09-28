// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { FALLBACK_MODELS, healStoredVision, mapCatalog } from "../src/catalog/index.ts";

test("T-CATALOG: usable ∩ available produces rows; max mode is extra", () => {
  const rows = mapCatalog(
    {
      models: [
        {
          name: "composer-2.5",
          supportsThinking: false,
          supportsMaxMode: true,
          supportsNonMaxMode: true,
          contextTokenLimit: 200000,
          contextTokenLimitForMaxMode: 1000000,
          clientDisplayName: "Composer 2.5",
          legacySlugs: [],
          idAliases: [],
          variants: [
            { displayName: "n", isMaxMode: false, isDefaultNonMaxConfig: true, parameterValues: [] },
            { displayName: "m", isMaxMode: true, isDefaultMaxConfig: true, parameterValues: [{ id: "context", value: "1m" }] },
          ],
        },
      ],
    },
    { models: [{ modelId: "composer-2.5", displayModelId: "", displayName: "Composer 2.5", displayNameShort: "", aliases: [] }] },
    { model: { modelId: "composer-2.5", displayModelId: "", displayName: "Composer 2.5", displayNameShort: "", aliases: [] } },
  );
  assert.ok(rows.some((r) => r.id === "composer-2.5"));
  assert.ok(rows.some((r) => r.id === "composer-2.5-max" && r.samplingParams?.cursorMaxMode === true));
  assert.deepEqual(rows.find((r) => r.id === "composer-2.5")?.input, ["text"]);
});

test("T-CATALOG: thinking levels become variant parameters, not model ids", () => {
  const rows = mapCatalog(
    {
      models: [
        {
          name: "grok-x",
          supportsThinking: true,
          supportsMaxMode: false,
          supportsNonMaxMode: true,
          contextTokenLimit: 256000,
          clientDisplayName: "Grok X",
          legacySlugs: [],
          idAliases: [],
          variants: [
            {
              displayName: "low",
              isMaxMode: false,
              legacySlug: "grok-x-low",
              parameterValues: [
                { id: "context", value: "256k" },
                { id: "reasoning_effort", value: "low" },
                { id: "fast", value: "false" },
              ],
            },
            {
              displayName: "high",
              isMaxMode: false,
              legacySlug: "grok-x-high",
              parameterValues: [
                { id: "context", value: "256k" },
                { id: "reasoning_effort", value: "high" },
                { id: "fast", value: "false" },
              ],
            },
          ],
        },
      ],
    },
    {
      models: [
        { modelId: "grok-x-low", displayModelId: "", displayName: "Grok X Low", displayNameShort: "", aliases: [] },
        { modelId: "grok-x-high", displayModelId: "", displayName: "Grok X High", displayNameShort: "", aliases: [] },
      ],
    },
    {},
  );
  const row = rows.find((r) => r.id === "grok-x");
  assert.ok(row, "the two effort members collapse into one row");
  assert.equal(row.thinkingLevelMap?.low, "grok-x-low", "the level map keeps the display slug");
  const cursorParams = row.samplingParams?.cursorParams as Record<string, { id: string; value: string }[]>;
  assert.deepEqual(cursorParams?.low, [{ id: "reasoning_effort", value: "low" }]);
  assert.deepEqual(cursorParams?.high, [{ id: "reasoning_effort", value: "high" }]);
});

test("T-CATALOG: empty available fails closed", () => {
  assert.throws(
    () =>
      mapCatalog(
        { models: [] },
        { models: [{ modelId: "x", displayModelId: "", displayName: "x", displayNameShort: "", aliases: [] }] },
        {},
      ),
    /no models/,
  );
});

test("T-CATALOG: static fallback is non-empty", () => {
  assert.ok(FALLBACK_MODELS.length >= 1);
  assert.deepEqual(FALLBACK_MODELS[0]?.input, ["text", "image"]);
});

test("T-CATALOG: supportsImages maps to input image", () => {
  const rows = mapCatalog(
    {
      models: [
        {
          name: "gemini-flash",
          supportsThinking: false,
          supportsImages: true,
          supportsMaxMode: false,
          supportsNonMaxMode: true,
          contextTokenLimit: 200000,
          clientDisplayName: "Gemini Flash",
          legacySlugs: [],
          idAliases: [],
          variants: [{ displayName: "n", isMaxMode: false, isDefaultNonMaxConfig: true, parameterValues: [] }],
        },
      ],
    },
    { models: [{ modelId: "gemini-flash", displayModelId: "", displayName: "Gemini Flash", displayNameShort: "", aliases: [] }] },
    {},
  );
  assert.deepEqual(rows[0]?.input, ["text", "image"]);
});

test("T-CATALOG: all-text persisted snapshot is treated as pre-vision cache", () => {
  const healed = healStoredVision([
    {
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      api: FALLBACK_MODELS[0]!.api,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    },
    {
      id: "composer-2.5",
      name: "Composer 2.5",
      api: FALLBACK_MODELS[0]!.api,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    },
  ]);
  assert.deepEqual(healed[0]?.input, ["text", "image"]);
  assert.deepEqual(healed[1]?.input, ["text", "image"]);
});

test("T-CATALOG: mixed persisted snapshot is left alone", () => {
  const rows = [
    {
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      api: FALLBACK_MODELS[0]!.api,
      reasoning: true,
      input: ["text", "image"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    },
    {
      id: "composer-2.5",
      name: "Composer 2.5",
      api: FALLBACK_MODELS[0]!.api,
      reasoning: false,
      input: ["text"] as ("text" | "image")[],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 64_000,
    },
  ];
  assert.equal(healStoredVision(rows), rows);
  assert.deepEqual(rows[1]?.input, ["text"]);
});
