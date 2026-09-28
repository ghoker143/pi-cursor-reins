// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * SPEC T-IDENT-CMDS — the only argv this provider may spawn.
 * Linux prefers reading files; hostname is last resort.
 */
export const IDENT_COMMANDS = {
  darwin: { bin: "ioreg", argv: ["-rd1", "-c", "IOPlatformExpertDevice"] as const },
  linuxFiles: ["/var/lib/dbus/machine-id", "/etc/machine-id"] as const,
  linuxFallback: { bin: "hostname", argv: [] as const },
  win32: {
    bin: "reg",
    argv: ["QUERY", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"] as const,
  },
  freebsdPrimary: { bin: "kenv", argv: ["-q", "smbios.system.uuid"] as const },
  freebsdFallback: { bin: "sysctl", argv: ["-n", "kern.hostuuid"] as const },
} as const;

export const REJECTED_MACS = new Set(["00:00:00:00:00:00", "ff:ff:ff:ff:ff:ff", "ac:de:48:00:11:22"]);
