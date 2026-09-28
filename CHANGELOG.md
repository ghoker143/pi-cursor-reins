# Changelog

All notable changes to this project are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
[SemVer](https://semver.org/).

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
