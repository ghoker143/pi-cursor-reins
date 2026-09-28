// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Live catalog probe (no secrets).
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { discoverModels } from "../src/catalog/index.ts";

function loadAccess(): string {
  const env = process.env.PI_CURSOR_TOKEN;
  if (env) return env;
  for (const path of [
    join(homedir(), ".config/pi/agent/auth.json"),
    join(homedir(), ".pi/agent/auth.json"),
  ]) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as { cursor?: { access?: string } };
      if (raw.cursor?.access) return raw.cursor.access;
    } catch {
      /* next */
    }
  }
  throw new Error("no cursor credential");
}

try {
  const models = await discoverModels({ token: loadAccess() });
  console.log(JSON.stringify({ ok: true, count: models.length, sample: models.slice(0, 8).map((m) => m.id) }));
} catch (error) {
  const err = error as { kind?: string; message?: string };
  console.log(JSON.stringify({ ok: false, kind: err.kind, message: err.message ?? String(error) }));
  process.exitCode = 1;
}
