// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { spawnSync } from "node:child_process";

test("T-FR2.c: spawn/exec only in identity", () => {
  const audit = spawnSync(process.execPath, ["--experimental-strip-types", "tools/audit/audit.ts"], {
    encoding: "utf8",
    cwd: new URL("..", import.meta.url).pathname,
  });
  assert.equal(audit.status, 0, audit.stdout + audit.stderr);
});

test("T-FR4: identity spawn env cannot receive token keys", () => {
  const src = readFileSync(new URL("../src/identity/index.ts", import.meta.url), "utf8");
  assert.match(src, /spawnEnv/);
  assert.doesNotMatch(src, /accessToken|Authorization|PI_CURSOR_TOKEN/);
  assert.match(src, /env: spawnEnv/);
});
