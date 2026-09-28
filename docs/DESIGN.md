# pi-cursor-reins — Design (layered architecture)

Status: Draft v0.1 · 2026-09-25 · The implementation defers to this file; code that conflicts with it is a defect.

Companions: [SPEC.md](./SPEC.md) (requirements and acceptance), PROTOCOL.md (M0 deliverable, wire fact source).

---

## 1. Overview

Positioned as the **thinnest possible inference adapter**: translate pi's transcript into one
inference request (either channel) and translate the event stream back to pi. No session ownership,
no local execution, no agent loop of its own.

```
┌─────────────────────────── pi (host) ────────────────────────────┐
│  session files · permission-system · lean-ctx · tool execution   │
└───────────────▲────────────────────────────────┬─────────────────┘
                │ AssistantMessage event stream   │ TranscriptContext
┌───────────────┴────────────────────────────────▼─────────────────┐
│ L7 extension/   pi registration (ProviderConfig / oauth / refreshModels) │
│ L6 compat/      pi version adapter: TranscriptContext → normalized IR    │
│ L5 catalog/     model discovery + persisted cache                        │
│ L4a session/    IR → RunInference request; event stream → IR events      │
│ L4b agent/      IR → AgentService/Run; exec audit rejects + MCP lift     │
│ L3 transport/   connect-rpc client (shared bidi stream), header stack    │
│ L2 identity/    host identity (platform adapters, process whitelist)     │
│ L1 auth/        OAuth login/refresh (pi AuthStorage)                     │
│ L0 proto/       wire types (InferenceService + agent.v1)                 │
└───────────────────────────────┬──────────────────────────────────┘
                                │ HTTPS connect-rpc
                                │ api2.cursor.sh (OAuth / catalog / RunInference)
                                │ agentn*.api5.cursor.sh (AgentService/Run)
               Cursor InferenceService/RunInference  or  AgentService/Run
               channel selected explicitly via CURSOR_PROVIDER_CHANNEL; no fallback
```

**Layering rules**
1. Dependencies point downward only; same-layer imports are forbidden; upper layers must not know
   lower-layer details (narrow interfaces only).
2. L0–L3 **import nothing from pi** — they are pure protocol libraries, independently testable and
   reusable.
3. Anything pi-related is confined to L6/L7.
4. Drift absorption points: Cursor protocol drift → L0–L4; pi version drift → L6; platform
   differences → L2.

## 2. Layer specifications

### L0 `src/proto/` — wire types

- Contents: the **minimal message surface** of `InferenceService/RunInference` (request top-level
  fields, model_message shape, tool-schema projection, the event-stream frame union, discovery RPC
  request/response), hand-written TS types with a per-field provenance comment (reverse-engineering
  fixture id).
- Principle: **declare only the fields we actually send/parse**; unknown fields do not enter the
  types (unknown frames are drift, judged at L4).
- Artifact cleanliness: no third-party code; comments reference entry ids in `docs/PROTOCOL.md`.
- Tests: type-level round-trip fixtures (`T-PROTO`).

### L1 `src/auth/` — login and credentials

- Implements the three pi `ProviderConfig.oauth` pieces: `login(callbacks)` / `refreshToken(credentials)`
  / `getApiKey(credentials)`.
- **Login is not standard OAuth** (PROTOCOL §7): PKCE-style deep link + 500ms polling of
  `api2.cursor.sh/auth/poll` (180s budget); the client_id is used for refresh only; credentials are
  `{type:"oauth",access,refresh,expires}` (expires pulled 5 minutes early).
- Persistence is entirely pi AuthStorage's job; this layer touches no files.
- Token use is concentrated in transport header construction; **no subprocess (see L2) ever receives
  a token** (impossible by construction of the parameters → statically provable).
- Tests: `T-AUTH` (login state machine against mock callbacks: 404 continue / 403 policy / timeout /
  success; expiry → refresh → request replay).

### L2 `src/identity/` — host identity

- Cursor's server validates the client machine identity (PROTOCOL §6); platform adapters compose
  fixed system identity sources into a stable hash.
- **L2 produces `{machineId, macMachineId?}`; checksum concatenation and base64 happen at L3** (the
  timestamp is a request-scope value).
- **Whitelisted command table** (the seed of SPEC's T-IDENT-CMDS, and the only set lean-ctx needs to
  allow):

  | platform | collection (fixed argv; linux prefers direct file reads, no subprocess) |
  |---|---|
  | darwin | `ioreg -rd1 -c IOPlatformExpertDevice` → `IOPlatformUUID` |
  | linux | direct read of `/var/lib/dbus/machine-id` / `/etc/machine-id` (no subprocess); only if both are missing, fall back to `hostname` |
  | windows | `REG QUERY HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid` |
  | freebsd | `kenv -q smbios.system.uuid` → fallback `sysctl -n kern.hostuuid` |

- Also collects `macMachineId` (SHA-256 of the first non-placeholder NIC MAC; absence is non-fatal).
- Implementation requirements: `spawn`/`spawnSync` only with array argv, injection-proof; a missing
  identity source → explicit error (FR-7 local), **never a silently generated random id** (avoids
  Cursor-side risk-control flags) and **no fallback UUID written to disk** (SPEC FR-8: nothing
  persisted).
- Caching: identity results are cached in process memory (no per-request spawn).
- Tests: `T-IDENT` (platform adapters through injected fakes; static diff of the whitelist table vs
  the spawn call sites).

### L3 `src/transport/` — Connect client + header stack + error classification

- **HTTP/2 bidi Connect-stream client** (PROTOCOL §1/§2: `run_request`→`run_ready`→multiple
  `invoke_model`→`invocation_end`); plus unary catalog calls (bare `application/proto` protobuf).
- Domain whitelist: `api2.cursor.sh` (OAuth / catalog / RunInference) and `agentn*.api5.cursor.sh`
  (AgentService); constants centralized in `src/constants.ts` + `src/transport/origin.ts`.
- The header stack is built item by item per PROTOCOL §5 (including `x-client-key`,
  `x-cursor-checksum` (PROTOCOL §6), `cookie: CursorCookie=Cookie-<first 15 chars of token>`); **no
  build-config exists**.
- Connect envelope and limits per PROTOCOL §1.6/§1.7 (≤16 MiB/frame; no compression below 1024 B,
  otherwise gzip; ≤64 pending invocations).
- Timeout/cancel: `AbortSignal` passed straight through (pi dispose → abort); `run_ready` 65s, idle
  120s, both env-tunable.
- Error classification (auth / network / protocol-drift / remote / local) via a unified
  `CursorError` carrying `kind`; in-stream `InferenceStreamErrorType` → kind mapping per PROTOCOL §2.2.
- Tests: `T-TRANS` (fake h2/Connect server: normal two-phase stream, mid-stream severing, 401,
  invalid frames, oversize frames).

### L4 `src/session/` — request assembly and event mapping (core)

- **Input**: the internal IR (produced by L6): `{ sessionId, systemPrompt, messages: NormalizedMessage[], tools: NormalizedTool[] }`.
- **Output**: a pi-independent internal event-stream IR (text/thinking/tool_call/usage/done/error)
  that L6 maps to pi's AssistantMessage events.
- Key decisions:
  1. **Remote is the primary timeline; local keeps a copy + handle** (FR-3): matching fingerprint →
     resume the Cursor conversation (checkpoint overlay, no history replay); stale → mint a new
     `conversation_id` and full-replay the Pi transcript.
  2. **No execution semantics**: this layer has no exec branch whatsoever; any frame that looks like
     an execution request → `protocol-drift` error (fail-closed, SPEC FR-2.b).
  3. tool_call → toolResult correspondence uses the server's `tool_call_id` verbatim
     (PROTOCOL §3); ids are never rewritten.
  4. Event termination semantics per PROTOCOL §2.2 (no done frame; `is_final`/`is_complete` +
     `invocation_end`); `stopReason` is inferred here and emitted as the IR done event.
  5. Long-history truncation policy: context caps per PROTOCOL §8; truncation emits an explicit
     warning event.
- Tests: `T-SESSION` (IR→request snapshot; event stream→IR snapshot; abnormal frame→drift error;
  tool round-trip fixtures).

### L4b `src/agent/` — agent-channel session and **the audit surface** (Cursor's own agent channel)

The second same-layer implementation (parallel to L4a, sharing L6's IR and L3's transport):

| file | responsibility |
| --- | --- |
| `policy.ts` | **audit core**: exec cases → decision table (per-case reject + redirect text + whitelist); **no new case without a schema-completeness test** |
| `blob-store.ts` | blob storage for prompts / tool results (**memory only**, 64 MiB cap, SPEC FR-8) |
| `root-prompt.ts` | pi transcript → `root_prompt_messages_json` (system rides as `user`+`<rules>`; historical tool calls replay as `mcp_pi_*`) |
| `request.ts` | `run_request` assembly (blob-ified `conversation_state`, handwritten `selected_context_blob` wire, `mcp_tools` declaration) |
| `session.ts` | session state machine: `interactionUpdate` → IR events; `execServerMessage` → audit decision; `mcpArgs` → pi toolCall; `kvServerMessage` → blob Q&A; `interactionQuery` → whitelist approval; `client_heartbeat` |

- **Audit invariant**: this layer has **no local-execution branch at all**. Every exec case is
  either rejected, lifted (in the `mcpArgs` case) into a pi tool call, or (in the
  `requestContextArgs` case) answered with a success containing only the tool list and the working
  directory. Unknown case → `ExecClientControlMessage.throw` (fail-closed; **never silent, never a
  forged success**).
- Completeness guard: `T-AGENT` enumerates the real oneof cases against the generated schema; any
  unclassified case fails the test outright.
- Tests: `T-AGENT` (decision table + completeness), `T-AGENT-SESSION` (local h2 replica: prompt/blob
  shapes, rejection frame shapes, MCP bridge, kv, context, L6 bridge).
- Wire facts and decisions: [PROTOCOL-AGENT.md](./PROTOCOL-AGENT.md).

### L5 `src/catalog/` — model catalog

- Discovery per PROTOCOL §8: `AiService/{AvailableModels, GetUsableModels, GetDefaultModelForCli}`
  three-way concurrent (unary + bare protobuf), mapped to `ProviderModelConfig[]` (including
  thinking/images/max-mode/context length).
- Persistence: `context.publish({persist})` (pi's mechanism), TTL 600s; offline/failure falls back
  to the cache with an explicit warning; a static fallback table ships with releases. A persisted
  snapshot where every row is `input:["text"]` is the pre-vision cache; it is healed to include
  images on restore and re-tightened to Cursor's `supportsImages` on the next online refresh.
- Tests: `T-CATALOG` (fakes: normal, empty, offline; error wording per PROTOCOL §8).

### L6 `src/compat/` — pi version adapter (one of only two pi touchpoints)

- Responsibility: `TranscriptContext` → IR (message normalization: string/array content, thinking,
  toolCall/toolResult, `ImageContent` → IR `images`. On the AgentService side, images Pi has already
  attached are lifted through; a stale `model.input` is not used to reject them locally —
  RunInference still rejects images). IR events → pi AssistantMessage event objects.
- **Every assumption about pi message shapes lives here**, each with a version comment
  (`// pi 0.87: content may be a string`); on a pi upgrade this file is the only checklist, and
  `T-COMPAT` freezes the assumptions.
- Tool-schema projection (pi JSON schema → the minimal shape Cursor accepts) also lives here, with
  the projection rules (and the dropped-field list) documented.
- Tests: `T-COMPAT` (real pi 0.87.x TranscriptContext samples → IR snapshot; and the reverse).

### L7 `src/extension/` — pi registration surface (thin)

- Entry `export default async function(pi)`:
  - `pi.registerProvider("cursor", ProviderConfig)`: `api` uses a unique name
    (`cursor-provider`); `streamSimple` dispatches per `CURSOR_PROVIDER_CHANNEL` (default `agent`)
    to L4b or L4a — **failures never cross channels**; `refreshModels` → L5; `oauth` → L1.
  - An environment diagnostics command (optional `pi_command`): prints network / credential /
    identity / cache state (troubleshooting-friendly).
- Contains no protocol or shape knowledge; every branch delegates downward and translates
  `CursorError.kind` into actionable user text on failure.
- Error UX: always include the "next step" (e.g. `kind=auth` → suggest `/login cursor`).

## 3. Per-request lifecycle

```
pi streamSimple(ctx)
  ├─ L6  ctx → IR (centralized assumption asserts; violation → local error)
  ├─ L1  obtain credentials (refresh if expired)
  ├─ L3  build header stack → open bidi stream (AbortSignal wired in)
  │      ├─ L4a  frame-by-frame parse → IR event stream (unknown frame → protocol-drift abort+error)
  │      └─ L4b  frame-by-frame parse → IR event stream + audit decisions (exec reject / MCP lift / blob Q&A)
  └─ L6  IR events → pi AssistantMessage events → yield
dispose → abort → L3 stops the stream, cleanup, run ends (no residual state)
```

## 4. Persistence inventory (SPEC FR-8 made concrete)

| data | location | writer |
|---|---|---|
| OAuth credentials | `~/.config/pi/agent/auth.json` | pi (we only provide callbacks) |
| model catalog cache | pi `context.publish(persist)` (models-store) | L5 (via pi's mechanism) |
| debug log | not written by default; when env-gated on, redacted to `.cursor-provider-debug.log` in cwd | L3/L4 |
| conversation content | Pi session file | pi |
| remote conversation handle | `~/.config/pi/agent/cursor-provider/handles/` (`CURSOR_PROVIDER_HANDLE_DIR`) | L4b (conversation_id / checkpoint / blobs / fingerprint) |

## 5. Test strategy

- Unit: each layer against fakes (suites L0/L1/L2/L3/L4/L5/L6, ids `T-<layer>`, one per layer spec).
- Contract: `fixtures/` records real RunInference traffic (redacted) and drives L3/L4 replay
  (mitigates R-3).
- End-to-end (real Cursor, not CI):
  1. A single turn; B cross-process resume pass phrase (T-FR3); C tool-boundary evidence (T-FR2.a/c).
  2. One run each in `pi -p` headless and RPC mode (the non-interactive model-selection problem we
     hit before must be verified at L7: models must appear on the non-interactive selection path).
- Static audit (CI-runnable): `tools/audit/` — spawn-whitelist diff, egress-domain diff,
  dependency-list check.

## 6. Dependencies and build

- Runtime dependency: **only `@bufbuild/protobuf`** (wire codec).
  - The transport layer is **handwritten `node:http2`** (see `src/transport/h2.ts`): Connect bidi +
    the custom envelope/compression threshold + half-close semantics all need exact control; a
    connect client would fight us (and without service definitions the generated clients are
    useless anyway). Hence no `@connectrpc/*` dependency (NFR-6 minimal deps).
- **No build step**: the TS sources are the published artifact (pi loads them via jiti, same shape
  as @offbynan). `tsconfig` serves editors and `npm run typecheck` only (strict for src, loose for
  test).
- Tests: `node --test` (Node-native TS stripping + tests load src via jiti); no build, no network.
- Static audit: `node tools/audit/audit.ts` (CI-runnable).
- Reference reading (dev-mode only): `pi-cursor-inference`'s dist exists only locally at
  `~/.config/pi/agent/npm/node_modules/pi-cursor-inference/dist/index.mjs` — **never copied, never
  imported, never committed**; the M0 reverse-engineering conclusions are frozen in
  `docs/PROTOCOL.md` (each with evidence and a verification plan). This repository does not depend
  on that file existing.

## 7. Milestones

| milestone | scope | exit criteria |
|---|---|---|
| M0 | docs/PROTOCOL.md + PROTOCOL-AGENT.md finalized | per-field provenance comments complete; no open "?" items |
| M1 | L0–L3 + L1 login + L5 catalog | `T-PROTO/T-AUTH/T-IDENT/T-TRANS/T-CATALOG` pass; `pi --list-models` shows them ✅ |
| M2 | L4a + L6 + L7 single turn | `pi -p --model cursor/…` single turn works (T-FR1/T-FR4) ✅ code ready; **this account is entitlement-rejected** (needs on-demand enabled) |
| M2' | L4b agent channel (the only path usable on this account) | `T-AGENT`/`T-AGENT-SESSION` pass; **VERIFIED 2026-09-25** `probe-agent.ts` HTTP 200 text `pong` |
| M3 | resume + tool boundary + acceptance | T-FR2/T-FR3/T-FR6/T-FR7 + static audit pass; v0.1.0 released |

## 8. Open questions

Converged by M0 into `docs/PROTOCOL.md §9` (U1–U9, each with a verification plan); this design doc
no longer tracks open items separately. Each U item carries a `PROTOCOL-U#` comment anchor in the
code; closed items are backfilled into PROTOCOL.

The original three, now concluded:
1. `checksum`/`client-key` do **not** come from the Cursor binary; both are client-generatable
   (PROTOCOL §5/§6) — no external dependency; R-1 risk accordingly lower.
2. The tool-schema shape Cursor accepts is `Struct{jsonSchema:<full JSON Schema>}`, no stripping
   (PROTOCOL §1.5); **no field-clipping list to maintain** (the wrap convention still needed the
   live confirmation in U5).
3. thinking/usage frame shapes are enumerated (PROTOCOL §2.2); whether per-model switches exist is
   decided by the catalog's `supports_thinking`.
