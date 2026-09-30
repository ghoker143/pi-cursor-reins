# pi-cursor-reins — Requirements Specification (SPEC)

Status: Draft v0.1 · 2026-09-25
Author: project maintainer
Scope: all code and release artifacts in this repository. Issue/PR acceptance criteria defer to this file.

---

## 1. Background and goals

Provide a **Cursor provider** for [pi coding agent](https://github.com/earendil-works/pi) ("pi"):
the default channel is Cursor's `agent.v1.AgentService/Run` (auditable: all native exec is refused;
Pi tools are projected over MCP and executed by pi); the optional `CURSOR_PROVIDER_CHANNEL=inference`
channel uses `aiserver.v1.InferenceService/RunInference`. Both channels leave sessions, tools,
branching, and transcripts entirely with pi. RunInference and AgentService are an **explicit choice**;
failures never fall back to the other channel.

### 1.1 Why we built this (community survey, 2026-09-25)

Surveyed every Cursor-related pi extension on npm/GitHub/pi.dev (12+). Conclusion:

| Category | Representative | Audit (no Cursor-side local exec) | resume | Maintenance |
|---|---|---|---|---|
| SDK/CLI/ACP | pi-cursor-sdk, @jiah-liu, pi-cursor-acp-provider | ✗ (tools executed by Cursor-side processes) | ~✓ | active |
| AgentService native fork | @rahularya01/pi-cursor | ✗ (native exec runs in-process) | ✓ | most active |
| AgentService proxy | @offbynan/pi-cursor-provider | ✓ (reject-all) | ✗ (needs external patch) | unmaintained, issues closed |
| **Pure inference** | pi-cursor-inference | ✓ (no execution surface by design) | ✓ in theory | unmaintained, not on pi 0.99 |

**Auditability and maintenance are anti-correlated in this community**: actively maintained
implementations all hand execution to the Cursor side; the two audit-compliant implementations have
both stopped. Hence this project — maintain only the thin "inference protocol" layer.

### 1.2 Three hard requirements (all measured, non-negotiable)

1. **The audit guarantee holds**: the model cannot execute anything locally through the Cursor side.
   Every local action must go through pi's tool system, hence through pi's permission system and
   lean-ctx allowlist.
2. **Resume works**: after `pi resume` or a new process selects this provider's models, conversation
   memory is intact.
3. **Maintainable**: clean layering; Cursor protocol drift and pi version drift each have a single
   designated absorption point; every failure path is fail-closed (explicit error, never silent
   degradation).

### 1.3 Scope boundaries

- No ACP / Cursor CLI subprocess / Cursor SDK channel with **any** local-execution semantics.
- `AgentService/Run` **is** allowed as the second explicit channel: Cursor native exec is always
  refused; Pi tools are projected as MCP (`provider_identifier=pi`) and executed by pi's permission
  system.
- The remote AgentService conversation **is the primary timeline** (it cannot be turned off).
  Locally we keep a Pi transcript copy plus a remote handle (`conversation_id`, checkpoint, blobs).
  Cross-process resume first restores the remote conversation; only when the handle is stale do we
  drop it and full-replay from local history.
- No third-party implementation is vendored (reverse-engineering references are dev-mode reading
  only and never enter the product).

---

## 2. Terminology

| Term | Meaning |
|---|---|
| pi | @earendil-works/pi-coding-agent, the host |
| provider | pi's provider concept; this project implements id `cursor` |
| RunInference | `aiserver.v1.InferenceService/RunInference`, a pure-inference bidi RPC (requires the managed-inference entitlement on the account) |
| AgentService | `agent.v1.AgentService/Run`, the Cursor CLI agent channel; this provider translates native exec into Pi tool calls and lifts MCP to pi (§FR-2, PROTOCOL-AGENT §5.1) |
| transcript | the normalized conversation pi hands to the provider (`TranscriptContext`) |
| native exec | local tool-execution requests in Cursor's agent-bridge protocol (read/shell/…) — translatable cases become Pi `tool_call`s executed under Pi's permission system; untranslatable cases are rejected and never succeed locally (PROTOCOL-AGENT §5.1) |
| fail-closed | any unrecognized/drifting wire behavior raises an error instead of guessing |

---

## 3. Functional requirements (FR)

Each item carries acceptance criteria; `T-*` ids map to the test suites (see "Test strategy" in DESIGN.md).

### FR-1 Inference path

Assemble pi's full transcript into a single request on the selected channel (default AgentService;
system prompt + complete message history + tool schemas), consume the streaming events, and map
them to pi's AssistantMessage event stream.

**Accept** `T-FR1`: single-turn conversation, model answers correctly (tool-independent); streaming
events reach pi frame by frame; interrupting (dispose) stops the stream.

### FR-2 Tool-execution boundary (audit)

1. The provider **does not execute** any Cursor native local tool (read/shell/write/fetch/…).
   On AgentService, translatable native execs (shell/shellStream/read/write/delete/grep incl.
   Glob) become regular Pi `tool_call`s — capability-matched against the registered tools,
   never hardcoded — so Pi's permission system stays the execution authority (PROTOCOL-AGENT
   §5.1); untranslatable cases (fetch, diagnostics, …) get a typed reject with a redirect, and
   unknown arms get a `throw`. Two exceptions: `start_grind_planning_args` (a Cursor-side
   plan-mode UI toggle; answered with an empty success ack, no local side effects — rationale
   in PROTOCOL-AGENT §5), and `CURSOR_PROVIDER_NATIVE_EXEC=inproc`, a probe-only in-process
   executor mode used to validate wire shapes against the live backend (never for real
   sessions). This invariant's intent (no unaudited in-process execution) is unchanged.
2. Tool calls flow one way only: the model returns tool calls via MCP/`tool_call_part` → pi executes
   → pi puts the toolResult into the next transcript (on AgentService, written back as `mcp_result`).
3. The only processes the provider itself spawns are the documented host-identity commands
   (FR-4.3); nothing else runs locally.

**Accept** `T-FR2`:
- (a) A session constructed so the model asks to run `bash -c "echo hi"`: the process inventory
  contains **only pi's own** tool executions; pi's allowlist rejects/approves under its existing
  rules (in our fixtures `bash` is not on the allowlist → visible rejection evidence).
- (b) Replay a forged exec request frame into the transport → the provider errors "protocol
  violation: this endpoint must not receive execution requests" with no local side effects.
- (c) Static check: no `spawn`/`exec`/`execSync` anywhere outside the identity platform adapters;
  identity commands live in a whitelist constant table (T-IDENT-CMDS).

### FR-3 Resume integrity

Cursor keeps the remote conversation and controls the dialogue flow. Locally:

1. The Pi session file remains the transcript **copy** (tools, rewind, and audit read it).
2. A remote handle is stored alongside: `conversation_id` + the last `conversation_checkpoint_update`
   + that Run's blob table + the fingerprint of completed user texts.

Cross-process / next user message: if the fingerprint matches, **resume the remote** conversation
(same `conversation_id` + overlaid checkpoint; the root prompt carries only current rules, history
is not replayed). On fingerprint mismatch, broken checkpoint, blob miss at resume, or remote
`not_found`: drop the handle, mint a new conversation, and full-replay local history once.

**Accept** `T-FR3`:
- (a) Process A memorizes the pass phrase `XK-PLATYPUS-77 / 林蓓`; process B `pi resume` on the same
  session → the model recalls the pass phrase.
- (b) After ≥3 cross-process turns, the model answers a question that depends on all history.
- (c) A non-stale resume request logs as `agent-resume` and its root prompt contains **none** of the
  earlier user texts; a stale resume (edited history) logs as `agent-rebuild`.

### FR-4 Login and credentials

1. OAuth via pi's `/login cursor` (compatible with the official flow).
2. Credentials live only in pi's `auth.json` (`AuthStorage`); expiry auto-refreshes.
3. The provider's local-action whitelist (FR-2.3): host-identity commands only, fixed argv, no
   user-input concatenation, explicit fallback or explicit error on failure.

**Accept** `T-FR4`: login → obtain credentials → force expiry → auto refresh → successful inference.
Credentials never enter any subprocess environment (static grep + runtime assertion).

### FR-5 Model catalog

Dynamic model discovery (Cursor's official discovery channel) via `refreshModels`; the catalog is
persisted through `context.publish({persist})`; offline/discovery failure falls back to the cache
with a warning. A static fallback table covers first load.

**Accept** `T-FR5`: after login the catalog matches the official IDE; offline restart still lists
models (cache); every non-interactive path (`pi -p --model cursor/…`, RPC `set_model`, UI `/model`)
can select them.

### FR-6 Tool schema passthrough

pi supplies arbitrary tool schemas (not just built-ins); they are projected into the request in the
minimal shape Cursor accepts; tool calls and toolResults round-trip losslessly on both sides
(including arguments JSON; long-text truncation policy explicitly documented).

**Accept** `T-FR6`: a fixture session with one custom tool completes "call → execute (pi) → result
written back → model uses the result" end to end; turns with ≥2 tool calls stay correctly ordered.

### FR-7 Lifecycle and errors

- `dispose`: stop the stream, release the connection, end this stream cleanly (no lingering inside
  CursorSession).
- Every error is classified: auth / network / protocol-drift / remote (Cursor refused) / local; all
  surface as pi standard errors with an actionable next step in the message.
- Any unrecognized protocol frame → **error** (never swallowed, never skipped) — proto drift must
  be loud, not silently misinterpreted.

**Accept** `T-FR7`: injected abnormal frames, severed streams, 401s, and explicit Cursor refusals
each produce the expected pi-side error message with no re-entry residue.

### FR-8 Compatibility statement

Declare the **tested pi version matrix** (this release: `0.99.x`). All assumptions about pi message
shapes live in the `compat/` layer (see DESIGN); code outside that layer must not depend on pi
internals; run `T-COMPAT` on every pi upgrade.

---

## 4. Non-functional requirements (NFR)

| id | requirement | metric / constraint |
|---|---|---|
| NFR-1 | Performance | Full-history rebuild is O(n); first-token timeout 30s, overall idle timeout 120s, both configurable; history truncation beyond thresholds emits an explicit warning |
| NFR-2 | Maintainability | Layering per DESIGN; cyclomatic complexity is not a hard gate, but every module must be independently unit-testable (clean dependency-injection boundaries) |
| NFR-3 | Observability | Every request yields bounded debug records (env-gated), sufficient to replay and localize: request summary / event frame counts / first and last errors |
| NFR-4 | Security | Credentials never leave auth.json; zero subprocesses except identity commands; network egress only to `api2.cursor.sh` (oauth/discovery/RunInference) and `agentn*.api5.cursor.sh` (AgentService); domain constants centralized and auditable |
| NFR-5 | Release | npm pi-package; no build step (pi loads TS directly via jiti); peers never pretend `*` compatibility — declare the tested matrix |
| NFR-6 | Minimal dependencies | Only connectrpc/protobuf-es runtime dependencies; no Cursor binary dependency |

## 5. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| R-1 Cursor closes/narrows anonymous or subscription access to RunInference | channel dead | explicit AgentService channel (still no native exec); `CURSOR_PROVIDER_CHANNEL` never silently switches |
| R-2 Host-identity algorithm stops working (Cursor tightens validation) | login/inference fails | identity layer independently testable; any process call outside the T-IDENT-CMDS table is treated as drift and alarmed |
| R-3 Proto event-shape drift | stream parsing corrupt | unknown frames always error (FR-7); recorded real-traffic fixtures act as contract tests |
| R-4 pi version message-shape drift | request assembly wrong | compat layer + T-COMPAT matrix |
| R-5 The pi-cursor-inference reference implementation disappears upstream | reverse-engineering baseline lost | our protocol docs (PROTOCOL.md) are the fact source; we do not depend on its continued existence |

## 6. Acceptance gate (Definition of Done for v1.0)

- `T-FR1..T-FR7` all pass (real Cursor environment, including Linux).
- `T-COMPAT` (pi 0.99.x) passes.
- All static audit checks pass: process whitelist, network domain whitelist, persistence inventory.
- docs: SPEC/DESIGN/PROTOCOL/README match behavior.
