// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { cursorChecksum } from "../src/transport/checksum.ts";
import { inferenceRequestHeaders } from "../src/transport/headers.ts";
import { assertCursorOrigin, assertAllowedOrigin, ALLOWED_ORIGINS } from "../src/transport/origin.ts";

test("T-TRANS: checksum is prefix + machineId[/mac]", () => {
  const sum = cursorChecksum({ machineId: "aa".repeat(32), macMachineId: "bb".repeat(32) }, 1_700_000_000_000);
  assert.match(sum, /^[A-Za-z0-9+/=]+[a-f0-9]{64}\/[a-f0-9]{64}$/);
});

test("T-TRANS: headers include cookie prefix and never a token as client-key", () => {
  const token = "tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const headers = inferenceRequestHeaders({
    token,
    identity: { machineId: "ab".repeat(32) },
    requestId: "11111111-1111-4111-8111-111111111111",
    clientKey: "ab".repeat(32),
    nowMs: 1_700_000_000_000,
    timezone: "UTC",
    platform: "linux",
    arch: "x64",
  });
  assert.equal(headers.cookie, `CursorCookie=Cookie-${token.slice(0, 15)}`);
  assert.equal(headers["x-client-key"], "ab".repeat(32));
  assert.equal(headers[":path"], "/aiserver.v1.InferenceService/RunInference");
  assert.ok(!headers["x-client-key"]?.includes(token));
});

test("T-TRANS: origin allowlist is api2.cursor.sh plus agentn", () => {
  assert.deepEqual([...ALLOWED_ORIGINS], ["https://api2.cursor.sh", "https://agentn.us.api5.cursor.sh"]);
  assert.equal(assertCursorOrigin("https://api2.cursor.sh").origin, "https://api2.cursor.sh");
  assert.throws(() => assertCursorOrigin("https://evil.example"), /allowlisted/);
  assert.equal(assertAllowedOrigin("https://agentn.us.api5.cursor.sh").origin, "https://agentn.us.api5.cursor.sh");
  assert.throws(() => assertAllowedOrigin("https://evil.api5.cursor.sh"), /allowlisted/);
  assert.throws(() => assertCursorOrigin("https://agentn.us.api5.cursor.sh"), /allowlisted/);
});
