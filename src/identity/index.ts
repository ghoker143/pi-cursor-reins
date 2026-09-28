// SPDX-License-Identifier: AGPL-3.0-or-later
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { IDENT_COMMANDS, REJECTED_MACS } from "./commands.ts";
import { localError } from "../errors.ts";

export interface MachineIdentity {
  machineId: string;
  macMachineId?: string;
}

export interface SpawnCall {
  bin: string;
  argv: readonly string[];
}

export interface IdentityDependencies {
  platform: NodeJS.Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  readFile: (path: string) => string;
  spawn: (call: SpawnCall) => string;
  interfaces: () => NodeJS.Dict<NetworkInterfaceInfo[]>;
}

/** Only PATH / Windows roots — never the caller env, never tokens. */
function spawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  if (env.PATH !== undefined) out.PATH = env.PATH;
  if (env.Path !== undefined) out.Path = env.Path;
  if (env.SystemRoot !== undefined) out.SystemRoot = env.SystemRoot;
  if (env.windir !== undefined) out.windir = env.windir;
  return out;
}

const defaultSpawn = (call: SpawnCall, env: NodeJS.ProcessEnv): string => {
  const result = spawnSync(call.bin, [...call.argv], {
    encoding: "utf8",
    timeout: 5000,
    env: spawnEnv(env),
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${call.bin} exited ${String(result.status)}: ${result.stderr}`);
  }
  return result.stdout;
};

export function normalizeHardwareId(platform: NodeJS.Platform, output: string): string {
  switch (platform) {
    case "darwin": {
      const value = output.split("IOPlatformUUID")[1]?.split("\n")[0];
      if (value === undefined) throw localError("IOPlatformUUID is missing", "check ioreg output");
      return value.replace(/=|\s+|"/gi, "").toLowerCase();
    }
    case "win32": {
      const value = output.split("REG_SZ")[1];
      if (value === undefined) throw localError("MachineGuid is missing", "check the Cryptography registry key");
      return value.replace(/\r+|\n+|\s+/gi, "").toLowerCase();
    }
    case "linux":
    case "freebsd":
      return output.replace(/\r+|\n+|\s+/gi, "").toLowerCase();
    default:
      throw localError(`Unsupported platform: ${platform}`, "run on linux, darwin, windows, or freebsd");
  }
}

export function firstUsableMac(ifaces: NodeJS.Dict<NetworkInterfaceInfo[]>): string {
  for (const name of Object.keys(ifaces)) {
    for (const entry of ifaces[name] ?? []) {
      const normalized = entry.mac.replace(/-/g, ":").toLowerCase();
      if (!REJECTED_MACS.has(normalized)) return entry.mac;
    }
  }
  throw new Error("no usable mac");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function linuxHardwareId(deps: IdentityDependencies): string {
  for (const path of IDENT_COMMANDS.linuxFiles) {
    try {
      const id = normalizeHardwareId("linux", deps.readFile(path));
      if (id !== "") return id;
    } catch {
      // try next
    }
  }
  return normalizeHardwareId("linux", deps.spawn(IDENT_COMMANDS.linuxFallback));
}

export function deriveHostMachineId(deps: IdentityDependencies): string {
  let hardwareId: string;
  switch (deps.platform) {
    case "darwin":
      hardwareId = normalizeHardwareId("darwin", deps.spawn(IDENT_COMMANDS.darwin));
      break;
    case "win32":
      hardwareId = normalizeHardwareId("win32", deps.spawn(IDENT_COMMANDS.win32));
      break;
    case "linux":
      hardwareId = linuxHardwareId(deps);
      break;
    case "freebsd":
      try {
        hardwareId = normalizeHardwareId("freebsd", deps.spawn(IDENT_COMMANDS.freebsdPrimary));
      } catch {
        hardwareId = normalizeHardwareId("freebsd", deps.spawn(IDENT_COMMANDS.freebsdFallback));
      }
      break;
    default:
      throw localError(`Unsupported platform: ${deps.platform}`, "run on linux, darwin, windows, or freebsd");
  }
  if (hardwareId === "") {
    throw localError("Host machine id is empty", "fix the platform identity source; refusing to invent a UUID");
  }
  return sha256(hardwareId);
}

export function deriveMacMachineId(deps: Pick<IdentityDependencies, "interfaces">): string | undefined {
  try {
    return sha256(firstUsableMac(deps.interfaces()));
  } catch {
    return undefined;
  }
}

let cached: MachineIdentity | undefined;

export function defaultIdentityDeps(): IdentityDependencies {
  return {
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    readFile: (path) => readFileSync(path, "utf8"),
    spawn: (call) => defaultSpawn(call, process.env),
    interfaces: networkInterfaces,
  };
}

export function loadMachineIdentity(deps: IdentityDependencies = defaultIdentityDeps()): MachineIdentity {
  if (cached) return cached;
  const machineId = deriveHostMachineId(deps);
  const macMachineId = deriveMacMachineId(deps);
  cached = macMachineId === undefined ? { machineId } : { machineId, macMachineId };
  return cached;
}

/** Test hook. */
export function resetIdentityCache(): void {
  cached = undefined;
}
