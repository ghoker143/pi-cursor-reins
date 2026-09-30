// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  calculateCost,
  createAssistantMessageEventStream,
  isModelType,
  type AssistantMessageEventStream,
  type Model,
  type OAuthCredentials,
  type OAuthLoginCallbacks,
  type RefreshModelsContext,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { createAuthRequest, getApiKey, pollAuth, refreshToken } from "../auth/index.ts";
import {
  cachedModels,
  discoverModels,
  FALLBACK_MODELS,
  healStoredVision,
  lastCatalogWarning,
  setCatalogWarning,
  type ProviderModelRow,
} from "../catalog/index.ts";
import {
  CHANNEL_ENV,
  CURSOR_ORIGIN,
  PROVIDER_API,
  PROVIDER_ID,
  PROVIDER_NAME,
  TOKEN_ENV,
} from "../constants.ts";
import { CursorError, localError } from "../errors.ts";
import { loadMachineIdentity } from "../identity/index.ts";
import { applyIrEvent, emptyAssistant, transcriptToIr } from "../compat/index.ts";
import type { IrEvent } from "../session/ir.ts";
import { irHasImages } from "../agent/images.ts";
import { runSession } from "../session/index.ts";
import { runAgentSession, agentOrigin } from "../agent/index.ts";
import { debugEnabled, debugLog } from "../transport/debug.ts";

function asConfig(rows: ProviderModelRow[]): ProviderModelConfig[] {
  return rows.map((m) => ({
    type: "chat",
    id: m.id,
    name: m.name,
    api: m.api,
    reasoning: m.reasoning,
    input: m.input,
    cost: m.cost,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    samplingParams: m.samplingParams,
    thinkingLevelMap: m.thinkingLevelMap,
  }));
}

function formatError(error: unknown): string {
  if (error instanceof CursorError) return error.userMessage();
  if (error instanceof Error) return error.message;
  return String(error);
}

function selectedChannel(env: NodeJS.ProcessEnv = process.env): "agent" | "inference" {
  const raw = env[CHANNEL_ENV]?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "agent") return "agent";
  if (raw === "inference") return "inference";
  throw localError(
    `CURSOR_PROVIDER_CHANNEL=${raw} is not a known channel`,
    "set CURSOR_PROVIDER_CHANNEL to agent or inference",
  );
}

export function streamSimple(
  model: Model<string>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  if (options?.apiKey === undefined || options.apiKey === "") {
    throw new Error("Cursor credential is unavailable — run /login cursor");
  }
  const stream = createAssistantMessageEventStream();
  const output = emptyAssistant(model);
  // Live sink: every IR event is applied (and pushed to Pi) as it happens, so
  // thinking / text / tool calls stream instead of landing all at once at turn end.
  const sink = { push: (e: unknown) => stream.push(e as never), output };
  const onEvent = (event: IrEvent) => applyIrEvent(sink, event);
  void (async () => {
    try {
      const ir = transcriptToIr(context, model, options);
      const payload = await options?.onPayload?.(ir, model);
      const used = payload === undefined ? ir : (payload as typeof ir);
      stream.push({ type: "start", partial: output });
      const channel = selectedChannel();
      if (channel === "inference" && irHasImages(used)) {
        throw localError(
          "Image input is not wired on the RunInference channel",
          "leave CURSOR_PROVIDER_CHANNEL unset (agent) or send text only",
        );
      }
      const result =
        channel === "inference"
          ? await runSession({
              token: options!.apiKey!,
              identity: loadMachineIdentity(),
              ir: used,
              signal: options?.signal,
              onEvent,
              hooks: {
                onResponse: async (status, headers) => {
                  await options?.onResponse?.({ status, headers }, model);
                },
              },
            })
          : await runAgentSession({
              token: options!.apiKey!,
              ir: used,
              signal: options?.signal,
              onEvent,
              hooks: {
                onResponse: async (status, headers) => {
                  await options?.onResponse?.({ status, headers }, model);
                },
              },
            });
      calculateCost(model, output.usage);
      const done = result.events.find((e) => e.type === "done");
      if (done && done.type === "done") {
        output.stopReason = done.stopReason;
        if (done.errorMessage) output.errorMessage = done.errorMessage;
        if (done.stopReason === "error") {
          stream.push({ type: "error", reason: "error", error: output });
        } else {
          stream.push({ type: "done", reason: done.stopReason, message: output });
        }
      } else {
        output.stopReason = "stop";
        stream.push({ type: "done", reason: "stop", message: output });
      }
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = formatError(error);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();
  return stream;
}

function persistCatalog(rows: ProviderModelRow[]) {
  return {
    models: rows.map((m) => ({
      type: "chat" as const,
      ...m,
      provider: PROVIDER_ID,
      api: PROVIDER_API,
      baseUrl: CURSOR_ORIGIN,
    })),
    checkedAt: Date.now(),
  };
}

async function restoreStoredCatalog(
  stored: ProviderModelRow[] | undefined,
  publish: RefreshModelsContext["publish"],
): Promise<ProviderModelConfig[] | undefined> {
  if (!stored || stored.length === 0) return undefined;
  const healed = healStoredVision(stored);
  if (healed !== stored) await publish({ persist: persistCatalog(healed) });
  return asConfig(healed);
}

async function refreshModels(context: RefreshModelsContext): Promise<ProviderModelConfig[]> {
  const stored = context.stored?.models
    ?.filter((m) => m.provider === PROVIDER_ID || m.api === PROVIDER_API)
    .filter((m) => isModelType(m, "chat"))
    .map(
      (m): ProviderModelRow => ({
        id: m.id,
        name: m.name,
        api: PROVIDER_API,
        reasoning: m.reasoning,
        input: Array.isArray(m.input) && m.input.includes("image") ? ["text", "image"] : ["text"],
        cost: m.cost,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        samplingParams: m.samplingParams,
        thinkingLevelMap: m.thinkingLevelMap as Record<string, string | null> | undefined,
      }),
    );

  debugLog({
    event: "catalog-refresh",
    outcome: "enter",
    allowNetwork: context.allowNetwork,
    storedRows: stored?.length ?? 0,
    force: context.force,
  });
  if (!context.allowNetwork) {
    const restored = await restoreStoredCatalog(stored, context.publish);
    if (restored) return restored;
    setCatalogWarning("Using static fallback model catalog (offline).");
    return asConfig(FALLBACK_MODELS);
  }
  const token =
    context.credential?.type === "oauth"
      ? context.credential.access
      : context.credential?.type === "api_key"
        ? context.credential.key
        : process.env[TOKEN_ENV];
  if (!token) {
    const restored = await restoreStoredCatalog(stored, context.publish);
    if (restored) {
      setCatalogWarning("No Cursor credential; using persisted catalog.");
      return restored;
    }
    setCatalogWarning("No Cursor credential; using static fallback catalog. Run /login cursor.");
    return asConfig(FALLBACK_MODELS);
  }

  try {
    const models = await discoverModels({ token, signal: context.signal, force: context.force });
    await context.publish({ persist: persistCatalog(models) });
    debugLog({ event: "catalog-refresh", outcome: "discovered", rows: models.length, force: context.force });
    return asConfig(models);
  } catch (error) {
    const message = formatError(error);
    debugLog({ event: "catalog-refresh", outcome: "failed", message, storedRows: stored?.length ?? 0 });
    const restored = await restoreStoredCatalog(stored, context.publish);
    if (restored) {
      setCatalogWarning(`Catalog refresh failed (${message}); using persisted catalog.`);
      return restored;
    }
    setCatalogWarning(`Catalog refresh failed (${message}); using static fallback.`);
    return asConfig(FALLBACK_MODELS);
  }
}

const oauth = {
  name: "Cursor",
  isSubscription: true,
  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    const request = createAuthRequest();
    callbacks.onAuth({ url: request.url, instructions: "Complete Cursor sign-in in your browser." });
    callbacks.onProgress?.("Waiting for Cursor sign-in…");
    const signal = callbacks.signal ?? new AbortController().signal;
    return await pollAuth(request, signal);
  },
  async refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
    return await refreshToken(credentials, signal);
  },
  getApiKey,
};

export function providerConfig(): ProviderConfig {
  return {
    name: PROVIDER_NAME,
    baseUrl: CURSOR_ORIGIN,
    api: PROVIDER_API,
    models: asConfig(FALLBACK_MODELS),
    streamSimple,
    refreshModels,
    oauth,
  };
}

export default async function register(pi: ExtensionAPI): Promise<void> {
  pi.registerProvider(PROVIDER_ID, providerConfig());
  pi.registerCommand("cursor-provider", {
    description: "Show Cursor native-inference diagnostics (no secrets)",
    handler: async (_args, ctx) => {
      let identity = "unavailable";
      try {
        const id = loadMachineIdentity();
        identity = `machineId=${id.machineId.slice(0, 8)}… mac=${id.macMachineId ? "yes" : "no"}`;
      } catch (error) {
        identity = formatError(error);
      }
      const cache = cachedModels();
      ctx.ui.notify(
        [
          `origin: ${CURSOR_ORIGIN}`,
          `agentOrigin: ${agentOrigin()}`,
          `channel: ${selectedChannel()}`,
          `api: ${PROVIDER_API}`,
          `debug: ${debugEnabled() ? "on" : "off"}`,
          `identity: ${identity}`,
          `catalog: ${cache ? `${String(cache.length)} models cached` : "empty"}`,
          `catalogWarning: ${lastCatalogWarning ?? "none"}`,
          `credential env: ${process.env[TOKEN_ENV] ? "PI_CURSOR_TOKEN set" : "unset (oauth via /login cursor)"}`,
        ].join("\n"),
        lastCatalogWarning ? "warning" : "info",
      );
    },
  });
}
