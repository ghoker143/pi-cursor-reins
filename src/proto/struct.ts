// SPDX-License-Identifier: AGPL-3.0-or-later
import { fromBinary, fromJson, toBinary, toJson } from "@bufbuild/protobuf";
import { StructSchema, ValueSchema } from "@bufbuild/protobuf/wkt";

export function jsonToStructBytes(value: Record<string, unknown>): Uint8Array {
  return toBinary(StructSchema, fromJson(StructSchema, value as never));
}

export function structBytesToJson(bytes: Uint8Array): Record<string, unknown> {
  return toJson(StructSchema, fromBinary(StructSchema, bytes)) as Record<string, unknown>;
}

export function jsonToValueBytes(value: unknown): Uint8Array {
  return toBinary(ValueSchema, fromJson(ValueSchema, value as never));
}

export function valueBytesToJson(bytes: Uint8Array): unknown {
  return toJson(ValueSchema, fromBinary(ValueSchema, bytes));
}
