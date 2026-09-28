// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthRequest, cursorTokenExpiry, pollAuth, refreshToken } from "../src/auth/index.ts";

function jwt(expSec: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSec })).toString("base64url");
  return `${header}.${payload}.x`;
}

test("T-AUTH: PKCE hashes the verifier string", () => {
  const bytes = Buffer.alloc(32, 7);
  const req = createAuthRequest({
    randomBytes: () => bytes,
    randomUuid: () => "11111111-1111-4111-8111-111111111111",
  });
  assert.match(req.url, /redirectTarget=cli/);
  assert.equal(req.verifier.length > 0, true);
  assert.notEqual(req.challenge, req.verifier);
});

test("T-AUTH: poll 404 continues then 200 succeeds; 403 policy fails", async () => {
  let n = 0;
  const access = jwt(Math.floor(Date.now() / 1000) + 3600);
  const cred = await pollAuth(
    { uuid: "u", verifier: "v" },
    new AbortController().signal,
    {
      sleep: async () => undefined,
      fetch: async () => {
        n += 1;
        if (n === 1) return new Response(null, { status: 404 });
        return Response.json({ accessToken: access, refreshToken: "r" });
      },
    },
  );
  assert.equal(cred.refresh, "r");
  assert.equal(cred.type, "oauth");
  assert.ok(cred.expires < Date.now() + 3600_000);

  await assert.rejects(
    () =>
      pollAuth({ uuid: "u", verifier: "v" }, new AbortController().signal, {
        sleep: async () => undefined,
        fetch: async () => Response.json({ error: "mdm" }, { status: 403 }),
      }),
    /sign-in policy/,
  );
});

test("T-AUTH: refresh keeps original refresh token; shouldLogout is auth error", async () => {
  const access = jwt(Math.floor(Date.now() / 1000) + 3600);
  const next = await refreshToken({ access: "old", refresh: "keep" }, new AbortController().signal, async () =>
    Response.json({ access_token: access }),
  );
  assert.equal(next.refresh, "keep");

  await assert.rejects(
    () =>
      refreshToken({ access: "old", refresh: "keep" }, new AbortController().signal, async () =>
        Response.json({ shouldLogout: true, access_token: access }),
      ),
    /revoked/,
  );
});

test("T-AUTH: expiry skew is 5 minutes", () => {
  const exp = Math.floor(Date.now() / 1000) + 600;
  const expires = cursorTokenExpiry(jwt(exp));
  assert.ok(Math.abs(expires - (exp * 1000 - 5 * 60 * 1000)) < 1000);
});

test("T-AUTH: poll with a tokenless 200 fails fast instead of polling forever", async () => {
  let n = 0;
  await assert.rejects(
    () =>
      pollAuth({ uuid: "u", verifier: "v" }, new AbortController().signal, {
        sleep: async () => undefined,
        fetch: async () => {
          n += 1;
          return Response.json({});
        },
      }),
    /missing tokens/,
  );
  assert.equal(n, 1, "deterministic shape drift must not be retried until the deadline");
});
