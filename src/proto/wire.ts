// SPDX-License-Identifier: AGPL-3.0-or-later
import { BinaryReader, BinaryWriter, WireType } from "@bufbuild/protobuf/wire";

export { BinaryReader, BinaryWriter, WireType };

export function encodeFields(write: (w: BinaryWriter) => void): Uint8Array {
  const w = new BinaryWriter();
  write(w);
  return w.finish();
}

export function writeString(w: BinaryWriter, field: number, value: string | undefined): void {
  if (value === undefined || value === "") return;
  w.tag(field, WireType.LengthDelimited).string(value);
}

/** Proto3 empty strings are omitted by writeString; MCP text items must still be present. */
export function writeStringAlways(w: BinaryWriter, field: number, value: string): void {
  w.tag(field, WireType.LengthDelimited).string(value);
}

export function writeBool(w: BinaryWriter, field: number, value: boolean | undefined): void {
  if (!value) return;
  w.tag(field, WireType.Varint).bool(true);
}

export function writeInt32(w: BinaryWriter, field: number, value: number | undefined): void {
  if (value === undefined || value === 0) return;
  w.tag(field, WireType.Varint).int32(value);
}

export function writeUint32(w: BinaryWriter, field: number, value: number | undefined): void {
  if (value === undefined || value === 0) return;
  w.tag(field, WireType.Varint).uint32(value);
}

/** Correlation ids must round-trip even when Cursor uses proto3 default 0. */
export function writeUint32Always(w: BinaryWriter, field: number, value: number): void {
  w.tag(field, WireType.Varint).uint32(value);
}

export function writeFloat(w: BinaryWriter, field: number, value: number | undefined): void {
  if (value === undefined) return;
  w.tag(field, WireType.Bit32).float(value);
}

export function writeBytes(w: BinaryWriter, field: number, value: Uint8Array | undefined): void {
  if (value === undefined || value.byteLength === 0) return;
  w.tag(field, WireType.LengthDelimited).bytes(value);
}

/** Oneof arms must be present even when the nested message is empty. */
export function writeBytesAlways(w: BinaryWriter, field: number, value: Uint8Array): void {
  w.tag(field, WireType.LengthDelimited).bytes(value);
}

export function writeMessage(w: BinaryWriter, field: number, bytes: Uint8Array | undefined): void {
  if (bytes === undefined || bytes.byteLength === 0) return;
  w.tag(field, WireType.LengthDelimited).bytes(bytes);
}

export function writeEnum(w: BinaryWriter, field: number, value: number | undefined): void {
  if (value === undefined || value === 0) return;
  w.tag(field, WireType.Varint).int32(value);
}

export function forEachField(
  bytes: Uint8Array,
  visit: (field: number, wire: WireType, reader: BinaryReader) => void,
): void {
  const reader = new BinaryReader(bytes);
  while (reader.pos < reader.len) {
    const [field, wire] = reader.tag();
    visit(field, wire, reader);
  }
}

export function expectBytes(reader: BinaryReader, wire: WireType): Uint8Array {
  if (wire !== WireType.LengthDelimited) {
    throw new Error(`expected length-delimited field, got wire type ${String(wire)}`);
  }
  return reader.bytes();
}

export function expectString(reader: BinaryReader, wire: WireType): string {
  return new TextDecoder().decode(expectBytes(reader, wire));
}

export function expectVarint(reader: BinaryReader, wire: WireType): number {
  if (wire !== WireType.Varint) {
    throw new Error(`expected varint field, got wire type ${String(wire)}`);
  }
  return reader.int32();
}

export function expectBool(reader: BinaryReader, wire: WireType): boolean {
  return expectVarint(reader, wire) !== 0;
}

export function skipUnknown(reader: BinaryReader, wire: WireType, field: number): void {
  reader.skip(wire, field);
}
