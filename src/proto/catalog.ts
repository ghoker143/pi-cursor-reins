// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  encodeFields,
  expectBool,
  expectBytes,
  expectString,
  expectVarint,
  skipUnknown,
  writeBool,
  writeBytes,
  writeString,
  forEachField,
} from "./wire.ts";

export interface AvailableModelVariant {
  displayName: string;
  isMaxMode: boolean;
  isDefaultMaxConfig?: boolean;
  isDefaultNonMaxConfig?: boolean;
  legacySlug?: string;
  parameterValues: { id: string; value: string }[];
}

export interface AvailableModel {
  name: string;
  supportsThinking?: boolean;
  supportsImages?: boolean;
  supportsMaxMode?: boolean;
  supportsNonMaxMode?: boolean;
  contextTokenLimit?: number;
  contextTokenLimitForMaxMode?: number;
  clientDisplayName?: string;
  serverModelName?: string;
  legacySlugs: string[];
  idAliases: string[];
  variants: AvailableModelVariant[];
}

export interface AvailableModelsResponse {
  models: AvailableModel[];
}

export interface ModelDetails {
  modelId: string;
  displayModelId: string;
  displayName: string;
  displayNameShort: string;
  aliases: string[];
  maxMode?: boolean;
}

export interface GetUsableModelsResponse {
  models: ModelDetails[];
}

export interface GetDefaultModelForCliResponse {
  model?: ModelDetails;
}

export function encodeAvailableModelsRequest(): Uint8Array {
  return encodeFields((w) => {
    writeBool(w, 5, true);
    writeBool(w, 7, true);
  });
}

export function encodeEmpty(): Uint8Array {
  return new Uint8Array();
}

function decodeVariant(bytes: Uint8Array): AvailableModelVariant {
  const v: AvailableModelVariant = {
    displayName: "",
    isMaxMode: false,
    parameterValues: [],
  };
  forEachField(bytes, (field, wire, reader) => {
    if (field === 1) {
      const p = { id: "", value: "" };
      forEachField(expectBytes(reader, wire), (f, wr, r) => {
        if (f === 1) p.id = expectString(r, wr);
        else if (f === 2) p.value = expectString(r, wr);
        else skipUnknown(r, wr, f);
      });
      v.parameterValues.push(p);
    } else if (field === 2) v.displayName = expectString(reader, wire);
    else if (field === 3) v.isMaxMode = expectBool(reader, wire);
    else if (field === 4) v.isDefaultMaxConfig = expectBool(reader, wire);
    else if (field === 5) v.isDefaultNonMaxConfig = expectBool(reader, wire);
    else if (field === 11) v.legacySlug = expectString(reader, wire);
    else skipUnknown(reader, wire, field);
  });
  return v;
}

function decodeAvailableModel(bytes: Uint8Array): AvailableModel {
  const model: AvailableModel = {
    name: "",
    legacySlugs: [],
    idAliases: [],
    variants: [],
  };
  forEachField(bytes, (field, wire, reader) => {
    if (field === 1) model.name = expectString(reader, wire);
    else if (field === 9) model.supportsThinking = expectBool(reader, wire);
    else if (field === 10) model.supportsImages = expectBool(reader, wire);
    else if (field === 14) model.supportsMaxMode = expectBool(reader, wire);
    else if (field === 15) model.contextTokenLimit = expectVarint(reader, wire);
    else if (field === 16) model.contextTokenLimitForMaxMode = expectVarint(reader, wire);
    else if (field === 17) model.clientDisplayName = expectString(reader, wire);
    else if (field === 18) model.serverModelName = expectString(reader, wire);
    else if (field === 19) model.supportsNonMaxMode = expectBool(reader, wire);
    else if (field === 30) model.variants.push(decodeVariant(expectBytes(reader, wire)));
    else if (field === 36) model.legacySlugs.push(expectString(reader, wire));
    else if (field === 37) model.idAliases.push(expectString(reader, wire));
    else skipUnknown(reader, wire, field);
  });
  return model;
}

export function decodeAvailableModelsResponse(bytes: Uint8Array): AvailableModelsResponse {
  const out: AvailableModelsResponse = { models: [] };
  forEachField(bytes, (field, wire, reader) => {
    if (field === 2) out.models.push(decodeAvailableModel(expectBytes(reader, wire)));
    else skipUnknown(reader, wire, field);
  });
  return out;
}

function decodeModelDetails(bytes: Uint8Array): ModelDetails {
  const m: ModelDetails = {
    modelId: "",
    displayModelId: "",
    displayName: "",
    displayNameShort: "",
    aliases: [],
  };
  forEachField(bytes, (field, wire, reader) => {
    if (field === 1) m.modelId = expectString(reader, wire);
    else if (field === 3) m.displayModelId = expectString(reader, wire);
    else if (field === 4) m.displayName = expectString(reader, wire);
    else if (field === 5) m.displayNameShort = expectString(reader, wire);
    else if (field === 6) m.aliases.push(expectString(reader, wire));
    else if (field === 7) m.maxMode = expectBool(reader, wire);
    else skipUnknown(reader, wire, field);
  });
  return m;
}

export function decodeGetUsableModelsResponse(bytes: Uint8Array): GetUsableModelsResponse {
  const out: GetUsableModelsResponse = { models: [] };
  forEachField(bytes, (field, wire, reader) => {
    if (field === 1) out.models.push(decodeModelDetails(expectBytes(reader, wire)));
    else skipUnknown(reader, wire, field);
  });
  return out;
}

export function decodeGetDefaultModelForCliResponse(bytes: Uint8Array): GetDefaultModelForCliResponse {
  const out: GetDefaultModelForCliResponse = {};
  forEachField(bytes, (field, wire, reader) => {
    if (field === 1) out.model = decodeModelDetails(expectBytes(reader, wire));
    else skipUnknown(reader, wire, field);
  });
  return out;
}
