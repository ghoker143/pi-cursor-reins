# Changelog

All notable changes to this project are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
[SemVer](https://semver.org/).

## 0.2.0 — 2026-09-29

- **Native exec translation is now the default behavior**: a Cursor native exec
  (shell/shellStream/read/write/delete/grep incl. Glob) is translated
  to a regular Pi `tool_call` — capability-matched against the actually registered tools, never a
  hardcoded name — so Pi's permission system executes it and the result is encoded back into the
  native wire shape (PROTOCOL-AGENT §5.1). The policy-text/reject-by-default approach is removed;
  the reject path remains as the fallback for cases no registered Pi tool can serve and for
  untranslatable cases (fetch, diagnostics, …). `CURSOR_PROVIDER_NATIVE_EXEC=inproc` keeps the
  probe-only in-process executors for wire validation.
  `deleteArgs` runs a composite `wc -c` + `rm` through the command tool — a DeleteSuccess
  without the real `file_size` stalls the backend (PROTOCOL-AGENT §5.1).
  Every native reply ends with `stream_close`, and parked
  execs send a 3 s per-exec heartbeat. Verified live by `tools/probe-long.ts`: a 20-turn
  conversation where every turn required a tool — 20/20 turns clean, 0 rejects, 0 derailments.
- **Resume omits `mcp_tools`** when the conversation handle's `toolsetKey` matches the current
  tool set (registration persists server-side, wire-verified); a changed set is re-sent
  automatically. `CURSOR_PROVIDER_RESEND_MCP_ON_RESUME=1` restores unconditional re-send.
- Probes: `tools/probe-native.ts` (native exec scenarios, drives the Pi side of translated calls),
  `tools/probe-resume.ts` (resume/mcp_tools matrix), `tools/probe-long.ts` (20-turn
  long-conversation compliance), `tools/probe-injection.ts` (server-side tool harness
  visibility) against the live backend.

## 0.1.1 — 2026-09-28

- README: corrected upstream pi repository URL (`earendil-works/pi`).
- README: reworded the introduction — channels stated up front; the security claim now says
  precisely "no local operation happens outside pi" instead of overclaiming "nothing executes
  on the Cursor side" (Cursor hosts the conversation loop and its own web tools).

## 0.1.0 — 2026-09-28

Initial release.

- Cursor provider for pi (provider id `cursor`, models `cursor/…`) using the Cursor subscription.
- Default channel `agent.v1.AgentService/Run`: Pi tools are projected as MCP tools
  (`provider_identifier=pi`) and executed by pi under its permission system; every Cursor native
  exec case is rejected by a completeness-tested audit table with a redirect to the equivalent Pi
  tool; unknown wire frames fail closed.
- Optional channel `CURSOR_PROVIDER_CHANNEL=inference`
  (`aiserver.v1.InferenceService/RunInference`, account entitlement required). Channels never fall
  back to each other.
- Remote conversation resume across processes via a persisted handle (`conversation_id` +
  checkpoint + blob store), with stale detection (rewind / edited user text) and a one-shot
  rebuild from the Pi transcript.
- Dynamic model catalog with persisted cache, static fallback, max-mode rows, thinking-effort
  variants, and vision support flags.
- OAuth login through pi (`/login cursor`), credentials only in pi's `auth.json`, automatic
  refresh.
- Vision input on the agent channel (user attachments and tool-result images).
- Redacted debug log (`CURSOR_PROVIDER_DEBUG=1`) and `/cursor-provider` diagnostics command.
- Static audit tooling: spawn whitelist, egress-domain allowlist, persistence inventory
  (`npm run audit`).
- 84 offline tests; tested against pi 0.87.x and live Cursor traffic (2026-09).
