#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Static audit: spawn whitelist, outbound domains, persist list.
 * Run: npm run audit
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const SRC = join(ROOT, "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const spawnHits: string[] = [];
const domainHits: string[] = [];
const persistHits: string[] = [];

const spawnRe = /\b(?:spawnSync|spawn|execSync|execFileSync|execFile|fork)\s*\(/;
const domainRe = /https?:\/\/[A-Za-z0-9._\-]+/g;

function domainAllowed(origin: string): boolean {
  if (origin === "https://api2.cursor.sh" || origin.startsWith("https://api2.cursor.sh/")) return true;
  if (origin === "https://cursor.com" || origin.startsWith("https://cursor.com/")) return true;
  if (origin === "https://agentn.us.api5.cursor.sh" || origin.startsWith("https://agentn.us.api5.cursor.sh/")) return true;
  try {
    const url = new URL(origin.includes("://") ? origin : `https://${origin}`);
    return /^agentn(?:\.[a-z0-9-]+)*\.api5\.cursor\.sh$/.test(url.hostname);
  } catch {
    return false;
  }
}

for (const file of files) {
  const rel = file.slice(SRC.length + 1);
  const text = readFileSync(file, "utf8");
  if (spawnRe.test(text) && !rel.startsWith("identity/")) {
    spawnHits.push(rel);
  }
  if (rel.startsWith("identity/") && /execSync|exec\s*\(/.test(text)) {
    spawnHits.push(`${rel} (exec not allowed; use spawnSync argv)`);
  }
  for (const m of text.match(domainRe) ?? []) {
    const origin = m.replace(/\/$/, "");
    const allowed = domainAllowed(origin);
    if (!allowed) domainHits.push(`${rel}: ${m}`);
  }
  if (/writeFile|appendFile/.test(text) && !rel.includes("debug.ts") && !rel.includes("handle-store.ts")) {
    persistHits.push(rel);
  }
}

const identity = readFileSync(join(SRC, "identity/commands.ts"), "utf8");
if (!identity.includes("ioreg") || !identity.includes("linuxFiles") || !identity.includes("MachineGuid")) {
  spawnHits.push("identity/commands.ts missing whitelist entries");
}

let failed = false;
const report = (name: string, hits: string[]): void => {
  if (hits.length === 0) {
    console.log(`ok  ${name}`);
    return;
  }
  failed = true;
  console.log(`FAIL ${name}`);
  for (const h of hits) console.log(`  - ${h}`);
};

report("spawn-whitelist", spawnHits);
report("domain-allowlist", domainHits);
report("persist-list", persistHits);

if (failed) process.exit(1);
console.log("audit passed");
