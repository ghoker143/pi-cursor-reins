# Changelog

All notable changes to this project are documented in this file. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning is
[SemVer](https://semver.org/).

## 0.3.0 — 2026-09-30

- **pi 0.99 only.** Peer range is `@earendil-works/pi-ai` / `pi-coding-agent` `>=0.99.0 <0.100.0`.
  Catalog rows are emitted as `type: "chat"` `ProviderModelConfig`s and restored with
  `isModelType(..., "chat")`.
- **Codemode fallback for native exec.** Default (`codemode.mode=on`) still translates native
  Shell/Read/Write/Grep/Delete to declared Pi tools. When those tools are hidden
  (`codemode.mode=only`), the same execs synthesize a `codemode` `{ code }` script
  (`tools.bash` / `tools.read` / `tools.write` / `tools.grep` / `tools.find`; delete still via
  `wc -c` + `rm`). `codemode` and `tool_search` score 0 in capability matching so their
  descriptions cannot steal a native match. Results unwrap the
  `"Script completed|failed\nWall time …\nOutput:\n"` header; a failed script sets `isError`.
- **cwd on 0.99 bash.** The bash schema has no `cwd`; translation wraps
  `cd -- ${quoted} && ${command}` when the matched tool has no cwd-like key.
- **MCP contract pins `codemode`.** `mcpContractText` always lists `mcp_pi_codemode(code)` first
  among extras so the 24-line cap cannot drop it.

## 0.2.1 — 2026-09-30

- **Fixed: tools registered mid-run were uncallable for the rest of the Run.** The exec
  dispatch gate checked only the `mcp_tools` catalog frozen at Run open, but Pi's tool
  registry can change mid-run — a gate tool (`web_enable` & co.) registers more tools
  after it executes, and the next continuation already refreshes `run.ir`. Cursor
  forwards unregistered tool names straight to exec (it does not validate against the
  run-request catalog), so the model's direct calls reached the provider and bounced as
  `mcp_not_found`: in session 01a0ede5 (2026-09-29) every `mcp_pi_web_search` call failed
  this way until the model fell back to Cursor's hosted webSearch. The gate now checks
  the advertised catalog **plus** the live registry (`run.ir.tools`), so a tool enabled
  mid-run lifts in the same Run. Genuinely unknown names still get the capability-ranked
  `mcp_not_found` alternatives and count against the miss budget only when absent from
  both sets. `mcpToolsOf` maps `ir.tools` 1:1, so the union can never unlock a tool the
  provider meant to withhold. Regression test drives the full gate → continuation →
  unadvertised-call sequence.

## 0.2.0 — 2026-09-29

- **Fixed: `not_found` for constructed model ids.** `requested_model.model_id` was the
  catalog's constructed family id, which AgentService rejects for many families (bare
  `cursor-grok-4.6`, every `-fast` family id, and `claude-sonnet-5-thinking` with effort
  params — all reproduced live). Remeasurement across grok/gpt/claude shows the published
  per-level slug is accepted for every family, while slug + effort params together are
  rejected. The provider now sends the thinking level's published slug (or the
  backend-marked default variant's slug when no level is selected) and drops the effort
  params on that path. Model list ids also normalize away the `cursor-` prefix some
  families carry, so `grok-4.6` lists consistently with `grok-4.7`.

- **Fixed: parallel tool-call batches could starve.** When the backend spread one turn's
  parallel exec frames over more than the 150 ms burst window (observed under concurrent
  load), lifts landing after the yield were emitted into an already-ended stream: Pi never
  saw them, the execs starved, and the turn stalled. Continuations now accept partial
  answers and re-yield unanswered pendings as a second toolUse batch. Regression test
  drives the second exec 400 ms late.

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
- **MCP contract in the rules**: Cursor never shows MCP tool descriptions/schemas to the model
  (probe-fidelity: markers absent on fresh runs and resumes, both grok-4.7 and composer-2.5), so
  pi-only tools — those not covered by native translation — get a one-line signature contract in
  the root rules (`mcpContractText`); probe-contract shows exact-argument calls, nested schemas
  included, guided by that contract alone.
- Probes: `tools/probe-native.ts` (native exec scenarios, drives the Pi side of translated calls),
  `tools/probe-resume.ts` (resume/mcp_tools matrix), `tools/probe-long.ts` (20-turn
  long-conversation compliance), `tools/probe-injection.ts` (server-side tool harness
  visibility), `tools/probe-fidelity.ts` (description/rules delivery), `tools/probe-contract.ts`
  (rules-carried contract), `tools/probe-edge.ts` (quoting/exit codes/missing files/unicode/
  spacey names/long commands/big output), `tools/probe-realworld.ts` (multi-step project task)
  against the live backend.

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
