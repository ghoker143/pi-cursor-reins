// SPDX-License-Identifier: AGPL-3.0-or-later
import assert from "node:assert/strict";
import { test } from "node:test";
import { IDENT_COMMANDS } from "../src/identity/commands.ts";
import {
  deriveHostMachineId,
  normalizeHardwareId,
  resetIdentityCache,
  type IdentityDependencies,
} from "../src/identity/index.ts";

test("T-IDENT: linux reads files first and does not spawn", () => {
  resetIdentityCache();
  const spawned: string[] = [];
  const deps: IdentityDependencies = {
    platform: "linux",
    arch: "x64",
    env: {},
    readFile: (path) => {
      if (path === "/var/lib/dbus/machine-id") return "abcDEF\n";
      throw Object.assign(new Error("enoent"), { code: "ENOENT" });
    },
    spawn: (call) => {
      spawned.push(call.bin);
      return "host";
    },
    interfaces: () => ({}),
  };
  const id = deriveHostMachineId(deps);
  assert.equal(id.length, 64);
  assert.deepEqual(spawned, []);
});

test("T-IDENT: linux falls back to hostname spawn with empty argv", () => {
  const calls: { bin: string; argv: readonly string[] }[] = [];
  const deps: IdentityDependencies = {
    platform: "linux",
    arch: "x64",
    env: {},
    readFile: () => {
      throw Object.assign(new Error("enoent"), { code: "ENOENT" });
    },
    spawn: (call) => {
      calls.push(call);
      return "myhost\n";
    },
    interfaces: () => ({}),
  };
  deriveHostMachineId(deps);
  assert.deepEqual(calls, [{ bin: "hostname", argv: [] }]);
});

test("T-IDENT: empty hardware id fails closed (no UUID)", () => {
  const deps: IdentityDependencies = {
    platform: "linux",
    arch: "x64",
    env: {},
    readFile: () => "   \n",
    spawn: () => "\n",
    interfaces: () => ({}),
  };
  assert.throws(() => deriveHostMachineId(deps), /empty|Host machine id/);
});

test("T-IDENT: darwin normalizes IOPlatformUUID", () => {
  const out = `"IOPlatformUUID" = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE"\n`;
  assert.equal(normalizeHardwareId("darwin", out), "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
});

test("T-IDENT-CMDS: whitelist table is the only argv source", () => {
  assert.deepEqual([...IDENT_COMMANDS.darwin.argv], ["-rd1", "-c", "IOPlatformExpertDevice"]);
  assert.deepEqual([...IDENT_COMMANDS.linuxFallback.argv], []);
  assert.equal(IDENT_COMMANDS.win32.bin, "reg");
});
