// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";
import {
  CATALOG_TTL_MS,
  CURSOR_ORIGIN,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  PROVIDER_API,
  PROVIDER_ID,
} from "../constants.ts";
import { TOKEN_ENV } from "../constants.ts";
import { localError, networkError } from "../errors.ts";
import {
  decodeAvailableModelsResponse,
  decodeGetDefaultModelForCliResponse,
  decodeGetUsableModelsResponse,
  encodeAvailableModelsRequest,
  encodeEmpty,
  type AvailableModel,
  type AvailableModelVariant,
  type GetDefaultModelForCliResponse,
  type GetUsableModelsResponse,
  type ModelDetails,
} from "../proto/catalog.ts";
import { unary } from "../transport/unary.ts";

export interface ProviderModelRow {
  id: string;
  name: string;
  api: typeof PROVIDER_API;
  reasoning: boolean;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  samplingParams?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, string | null>;
}

export const FALLBACK_MODELS: ProviderModelRow[] = [
  {
    id: "composer-2.5",
    name: "Composer 2.5",
    api: PROVIDER_API,
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  },
];

const effortSuffix = /^(.*)-(none|minimal|low|medium|high|xhigh|extra-high|max)(-fast)?$/;
const levels: Record<string, string> = {
  none: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  "extra-high": "xhigh",
  max: "max",
};

export let lastCatalogWarning: string | undefined;

interface Cache {
  key: string;
  expiresAt: number;
  models: ProviderModelRow[];
}

let cache: Cache | undefined;

function familyFor(model: ModelDetails): { id: string; level: string } {
  const matched = effortSuffix.exec(model.modelId);
  const base = matched?.[1];
  const effort = matched?.[2];
  const fast = matched?.[3] === "-fast";
  const level = effort === undefined ? undefined : levels[effort];
  return base === undefined || level === undefined
    ? { id: model.modelId, level: "off" }
    : { id: `${base}${fast ? "-fast" : ""}`, level };
}

function displayName(model: ModelDetails): string {
  return model.displayName || model.displayNameShort || model.displayModelId || model.modelId;
}

function contextParameterTokens(value: string | undefined): number | undefined {
  const matched = /^(\d+(?:\.\d+)?)([km])$/i.exec(value ?? "");
  if (!matched) return undefined;
  const amount = Number(matched[1]);
  const multiplier = matched[2]?.toLowerCase() === "m" ? 1_000_000 : 1_000;
  const tokens = amount * multiplier;
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : undefined;
}

function variantContext(model: AvailableModel, maxMode: boolean): string | undefined {
  const variant = model.variants.find((c) => (maxMode ? c.isDefaultMaxConfig === true : c.isDefaultNonMaxConfig === true));
  return variant?.parameterValues.find((p) => p.id === "context")?.value;
}

function contextWindow(model: AvailableModel, maxMode: boolean): number {
  const selected = contextParameterTokens(variantContext(model, maxMode));
  if (selected !== undefined) return selected;
  const captured = maxMode ? (model.contextTokenLimitForMaxMode ?? model.contextTokenLimit) : model.contextTokenLimit;
  return captured !== undefined && captured > 0 ? captured : DEFAULT_CONTEXT_WINDOW;
}

function hasDistinctMaxMode(model: AvailableModel): boolean {
  if (model.supportsMaxMode !== true) return false;
  if (model.supportsNonMaxMode === false) return true;
  if (
    model.contextTokenLimitForMaxMode !== undefined &&
    model.contextTokenLimitForMaxMode !== model.contextTokenLimit
  ) {
    return true;
  }
  return model.variants.some((v) => v.isMaxMode);
}

export function mapCatalog(
  available: { models: AvailableModel[] },
  usable: GetUsableModelsResponse,
  fallbackDefault: GetDefaultModelForCliResponse,
): ProviderModelRow[] {
  if (available.models.length === 0) throw networkError("Cursor AvailableModels returned no models");
  const grouped = new Map<string, { model: ModelDetails; level: string }[]>();
  for (const model of usable.models) {
    if (model.modelId === "") continue;
    const member = familyFor(model);
    const list = grouped.get(member.id) ?? [];
    list.push({ model, level: member.level });
    grouped.set(member.id, list);
  }
  const rows: ProviderModelRow[] = [];
  // Effort/thinking lives on the AVAILABLE-model variants as parameterValues; the
  // usable list only carries model ids. `legacySlug` is that model id, so it joins them.
  const variantBySlug = new Map<string, AvailableModelVariant>();
  for (const model of available.models) {
    for (const variant of model.variants) {
      if (variant.legacySlug !== undefined && variant.legacySlug !== "") variantBySlug.set(variant.legacySlug, variant);
    }
  }
  for (const [rawId, members] of grouped) {
    // Display-id normalization: Cursor publishes some families with a `cursor-`
    // prefix (cursor-grok-4.6) and their successors without (grok-4.7). Strip the
    // prefix when it collides with nothing so the pi model list is consistent.
    // The id is display-only; the wire model_id comes from thinkingLevelMap.
    const stripped = rawId.startsWith("cursor-") ? rawId.slice("cursor-".length) : rawId;
    const id = stripped !== rawId && !grouped.has(stripped) ? stripped : rawId;
    const memberIds = new Set(members.map((m) => m.model.modelId));
    const base = available.models.find(
      (m) =>
        m.name === rawId ||
        m.name === id ||
        m.idAliases.includes(rawId) ||
        m.idAliases.includes(id) ||
        m.legacySlugs.some((s) => memberIds.has(s)) ||
        m.variants.some((v) => v.legacySlug !== undefined && memberIds.has(v.legacySlug)),
    );
    if (!base) continue;
    const thinkingLevelMap: Record<string, string | null> = {};
    const cursorParams: Record<string, { id: string; value: string }[]> = {};
    for (const m of members) {
      thinkingLevelMap[m.level] = m.model.modelId;
      // The per-level slugs ARE valid requested_model.model_id values (they come
      // from GetUsableModels verbatim; measured 2026-09-29). What AgentService
      // rejects is the CONSTRUCTED family id (e.g. bare `cursor-grok-4.6` or any
      // `-fast` family id) — familyFor invents those and they are not published.
      const params = (variantBySlug.get(m.model.modelId)?.parameterValues ?? []).filter(
        (p) => p.id !== "context" && p.id !== "fast",
      );
      if (params.length > 0) cursorParams[m.level] = params;
    }
    // Default slug for requests that carry no explicit thinking level: the
    // backend marks a default variant; its legacySlug is a published usable id.
    const defaultSlug = base.variants.find(
      (v) => v.isDefaultNonMaxConfig === true && v.legacySlug !== undefined && v.legacySlug !== "",
    )?.legacySlug;
    const capturedName =
      base.clientDisplayName && base.clientDisplayName !== ""
        ? base.clientDisplayName
        : displayName(members[0]!.model).replace(/ (?:None|Minimal|Low|Medium|High|Extra High|Max)(?= Fast$|$)/, "");
    const push = (maxMode: boolean): void => {
      const context = variantContext(base, maxMode);
      const samplingParams: Record<string, unknown> = {
        ...(maxMode ? { cursorMaxMode: true } : {}),
        ...(context === undefined ? {} : { cursorContext: context }),
        ...(Object.keys(cursorParams).length > 0 ? { cursorParams } : {}),
        ...(maxMode || defaultSlug === undefined ? {} : { cursorDefaultModelId: defaultSlug }),
      };
      rows.push({
        id: `${id}${maxMode ? "-max" : ""}`,
        name: `${capturedName}${maxMode ? " Max" : ""}`,
        api: PROVIDER_API,
        reasoning: base.supportsThinking === true,
        input: base.supportsImages === true ? ["text", "image"] : ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: contextWindow(base, maxMode),
        maxTokens: DEFAULT_MAX_TOKENS,
        ...(Object.keys(samplingParams).length > 0 ? { samplingParams } : {}),
        ...(Object.keys(thinkingLevelMap).length > 0 ? { thinkingLevelMap } : {}),
      });
    };
    if (base.supportsNonMaxMode !== false) push(false);
    if (hasDistinctMaxMode(base)) push(true);
  }
  if (rows.length === 0) throw networkError("Cursor catalog returned no fully described usable models");
  const defaultId = fallbackDefault.model?.modelId;
  if (defaultId) {
    const usableIds = new Set(usable.models.map((m) => m.modelId));
    if (!usableIds.has(defaultId)) throw networkError(`Cursor default model '${defaultId}' is not usable`);
  }
  return rows;
}

/**
 * Pre-vision persists wrote every Cursor row as `input: ["text"]`.
 * A snapshot with zero image rows is that cache, not Cursor saying nothing is multimodal.
 */
export function healStoredVision(rows: ProviderModelRow[]): ProviderModelRow[] {
  if (rows.length === 0 || rows.some((row) => row.input.includes("image"))) return rows;
  return rows.map((row) => ({ ...row, input: ["text", "image"] }));
}

export async function discoverModels(options: {
  token: string;
  signal?: AbortSignal;
  force?: boolean;
}): Promise<ProviderModelRow[]> {
  if (options.token.includes("\r") || options.token.includes("\n")) {
    throw localError("Cursor credential contains a line break", "run /login cursor");
  }
  const now = Date.now();
  // Key by credential hash, never length: two accounts with equal-length tokens
  // must not share a catalog cache entry.
  const key = `${CURSOR_ORIGIN}:${createHash("sha256").update(options.token).digest("hex").slice(0, 32)}`;
  if (options.force !== true && cache?.key === key && cache.expiresAt > now) return cache.models;
  const [availableBytes, usableBytes, defaultBytes] = await Promise.all([
    unary({ token: options.token, method: "AvailableModels", body: encodeAvailableModelsRequest(), signal: options.signal }),
    unary({ token: options.token, method: "GetUsableModels", body: encodeEmpty(), signal: options.signal }),
    unary({ token: options.token, method: "GetDefaultModelForCli", body: encodeEmpty(), signal: options.signal }),
  ]);
  const models = mapCatalog(
    decodeAvailableModelsResponse(availableBytes),
    decodeGetUsableModelsResponse(usableBytes),
    decodeGetDefaultModelForCliResponse(defaultBytes),
  );
  cache = { key, expiresAt: now + CATALOG_TTL_MS, models };
  lastCatalogWarning = undefined;
  return models;
}

export function cachedModels(): ProviderModelRow[] | undefined {
  return cache?.models;
}

export function setCatalogWarning(message: string): void {
  lastCatalogWarning = message;
}

export { TOKEN_ENV, PROVIDER_ID };
