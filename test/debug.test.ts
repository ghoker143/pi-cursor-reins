// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { redact } from "../src/transport/debug.ts";

test("T-DEBUG: redact covers Bearer, cookie, every credential key shape, and bare JWTs", () => {
  assert.equal(redact("Authorization: Bearer abc.def.ghi"), "Authorization: Bearer ***");
  assert.equal(redact("CursorCookie=Cookie-xyz; other=1"), "CursorCookie=Cookie-***; other=1");
  const json = JSON.stringify({
    accessToken: "secretA",
    refreshToken: "secretB",
    access_token: "secretC",
    refresh_token: "secretD",
    token: "secretE",
    nested: { ok: 1 },
  });
  const out = redact(json);
  assert.ok(!out.includes("secret"), `credential key shapes must be redacted, got: ${out}`);
  assert.ok(out.includes('"ok":1'), "non-secret fields survive");
  const jwtLike = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefgh";
  assert.ok(!redact(`saw ${jwtLike} here`).includes("eyJhbGci"), "bare JWT fallback");
});
