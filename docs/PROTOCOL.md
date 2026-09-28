# pi-cursor-reins — wire protocol (RunInference)

Status: v0.1 · 2026-09-25
This file is the wire fact source for L0–L4. Implementation that contradicts it is a defect.
Evidence: reconstructed `aiserver.v1` surface (Cursor IDE 3.18.9 managed inference) plus Connect v1.
Nothing here is copied from a third-party plugin into the product.

Live-account notes are labelled **VERIFY**. DESIGN.md M2’s “entitlement rejected” claim is **not** treated as fact until a probe against this account records HTTP status + error body kind.

---

## §1 Transport (Connect over HTTP/2)

- Origin (NFR-4): `https://api2.cursor.sh` for OAuth, catalog, RunInference. AgentService origin is `https://agentn.us.api5.cursor.sh` (see PROTOCOL-AGENT.md).
- RPC: `POST /aiserver.v1.InferenceService/RunInference`
- Content-Type: `application/connect+proto`
- Headers: `connect-protocol-version: 1`, `connect-accept-encoding: gzip`, `te: trailers`
- HTTP/2 streaming request/response (bidi). Client may half-close after `finish_run`.

### §1.1 Conversation identifier

`RunInferenceRunRequest.conversation_id` is a **routing key**, not a server-owned journal.
This provider always sends the full transcript on each `invoke_model`. Resume is Pi session files, not Cursor conversation state.

Use Pi `SimpleStreamOptions.sessionId` when present; otherwise a fresh UUID (still full replay).

### §1.5 Tools

`InferenceAgentTool.parameters` is `google.protobuf.Struct` wrapping `{ jsonSchema: <JSON Schema object> }`.
No field stripping. Unknown JSON Schema keywords are forwarded as-is.

Tool call ids: `tool_call_id` from the server is echoed on the next-turn `toolResult` (**§3**). This provider never rewrites ids.

### §1.6 Connect envelope

Each frame: `uint8 flags` + `uint32be length` + payload.

| bit | meaning |
|---|---|
| 0 | gzip compressed payload |
| 1 | end-of-stream (JSON trailer, not protobuf) |

Compression: payload `< 1024` bytes is never gzip’d; otherwise gzip. Max payload **16 MiB**. Trailing partial frames at stream end are errors.

### §1.7 Limits

- Pending invocations on one run ≤ 64.
- `run_ready` wait: 65s (env `CURSOR_PROVIDER_RUN_READY_MS`).
- Idle between frames: 120s (env `CURSOR_PROVIDER_IDLE_MS`).
- First content token after `invoke_model`: 30s (env `CURSOR_PROVIDER_FIRST_TOKEN_MS`).

---

## §2 RunInference stream

Client oneof (`RunInferenceClientMessage`):

| field | case | when |
|---|---|---|
| 1 | `run_request` | open the run (model + conversation_id + routing text) |
| 2 | `invoke_model` | one correlated inference (`invocation_id` + full `InferenceStreamRequest`) |
| 3 | `cancel_invocation` | abort one invocation |
| 4 | `finish_run` | end the run |

Server oneof (`RunInferenceServerMessage`):

| field | case | handling |
|---|---|---|
| 1 | `heartbeat` | ignore (resets idle timer) |
| 2 | `run_ready` | required before `invoke_model`; missing `resolved_model.model_id` is protocol-drift |
| 3 | `invocation_response` | inner `InferenceStreamResponse` |
| 4 | `invocation_end` | terminal for that invocation |

**Any other outer field number is protocol-drift** and is treated as a possible execution-channel leak:

> Protocol violation: this endpoint must not receive execution requests

This endpoint has **no** exec/MCP/blob case. This provider never sends those frames and never acts on them.

### §2.2 Inner stream (`InferenceStreamResponse`)

| field | case | IR |
|---|---|---|
| 1 | `text_part` | text delta; `is_final` closes the text block |
| 2 | `tool_call_part` | tool-call delta; `is_complete` closes the call (args are JSON object) |
| 3 | `usage` | prompt/completion tokens (ignored if `extended_usage` already seen) |
| 4 | `response_info` | final message copy + optional `error_message` |
| 5 | `extended_usage` | input/output/cacheRead/cacheWrite |
| 6 | `provider_metadata` | ignored (untyped; no billed-cost contract) |
| 7 | `invocation_id` | must match the outer invocation |
| 8 | `error` | see error-type map |
| 9 | `thinking_part` | thinking delta; `is_final` closes |
| 10 | `image_descriptions` | ignored (output-only; input images travel on AgentService) |

No `done` frame. Terminal is `invocation_end` plus `is_final`/`is_complete` on open blocks.

`InferenceStreamErrorType` → `CursorError.kind`:

| enum | kind | note |
|---|---|---|
| INPUT_TOKEN_LIMIT (2) or `is_input_token_limit_error` | remote | message prefixed `context_length_exceeded:` so Pi can compact |
| OUTPUT_TOKEN_LIMIT (3) | remote | stopReason `length` if any content exists |
| AUTHENTICATION (5) / PERMISSION (6) | auth | next step: `/login cursor` |
| RATE_LIMIT (4) / OVERLOADED (7) | remote | |
| CONTENT_FILTER (8) | remote | |
| unknown / unset | remote | |

HTTP 401/403 → `auth`. TCP/TLS/HTTP2 connect failures → `network`.

---

## §3 Tool round-trip

1. Model streams `tool_call_part` with server `tool_call_id`.
2. Pi executes the tool (this provider does not).
3. Next `invoke_model` includes a `TOOL` role message whose `tool_content.parts[].tool_call_id` is the **same** id.
4. `args` on the wire are `google.protobuf.Struct`. Stream deltas are a JSON string (concatenated until `is_complete`, then parsed as an object).

Long tool results: sent in full as a protobuf `Value` (string if one text part, array of `{type,text}` if several). No silent truncation. If the Connect frame would exceed 16 MiB the request fails closed (`local`).

---

## §5 Request headers (RunInference)

Pinned to Cursor IDE 3.18.9 managed-inference control (no build-config blob):

| header | value |
|---|---|
| `:method` | `POST` |
| `:path` | `/aiserver.v1.InferenceService/RunInference` |
| `authorization` | `Bearer <access>` |
| `cookie` | `CursorCookie=Cookie-<first 15 chars of token>` |
| `connect-protocol-version` | `1` |
| `connect-accept-encoding` | `gzip` |
| `connect-content-encoding` | `gzip` |
| `content-type` | `application/connect+proto` |
| `user-agent` | `connect-es/1.6.1` |
| `x-amzn-trace-id` | `Root=<request UUID>` |
| `x-client-key` | 32-byte lowercase hex (process-stable random; never a token) |
| `x-cursor-checksum` | §6 |
| `x-cursor-client-version` | `3.18.9` |
| `x-cursor-client-commit` | `2ba48ff3f7514cc4643c52ca9f7b3173d9b66130` |
| `x-cursor-client-type` | `ide` |
| `x-cursor-client-os` | Node `process.platform` |
| `x-cursor-client-arch` | Node `process.arch` |
| `x-cursor-client-device-type` | `desktop` |
| `x-cursor-streaming` | `true` |
| `x-cursor-timezone` | IANA timezone |
| `x-ghost-mode` | `false` |
| `x-new-onboarding-completed` | `false` |
| `x-request-id` | UUID |

Tokens never enter subprocess environments. Header construction is in-process only.

---

## §6 Host identity and checksum

L2 produces `{ machineId, macMachineId? }`. L3 builds checksum.

`machineId` = SHA-256 hex of a normalized hardware id:

| platform | source (fixed argv; no user input) |
|---|---|
| darwin | `ioreg -rd1 -c IOPlatformExpertDevice` → `IOPlatformUUID` |
| linux | read `/var/lib/dbus/machine-id` then `/etc/machine-id`; both missing → `hostname` |
| windows | `reg QUERY HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid` |
| freebsd | `kenv -q smbios.system.uuid` then `sysctl -n kern.hostuuid` |

Missing identity → **local error**, no random UUID, no disk fallback.

`macMachineId` = SHA-256 hex of the first non-placeholder NIC MAC (`00:00:00:00:00:00`, `ff:ff:ff:ff:ff:ff`, `ac:de:48:00:11:22` rejected). Absence is non-fatal.

Checksum (JS 32-bit shift semantics, matching IDE 3.18.9):

1. `minute = floor(nowMs / 1_000_000)`
2. six bytes: `(minute>>40)&255 … minute&255` (JS `>>`)
3. rolling XOR seed 165: `b[i] = ((b[i] ^ prev) + (i % 256)) & 255`
4. standard base64 of those 6 bytes
5. `prefix + machineId` or `prefix + machineId + '/' + macMachineId`

---

## §7 OAuth (not a standard code+redirect grant)

- Login URL: `https://cursor.com/loginDeepControl?challenge&uuid&mode=login&supportsSelectedTeamLogin=true&redirectTarget=cli`
- PKCE: 32 random bytes → base64url verifier; **challenge hashes the verifier string as UTF-8**, not the raw bytes.
- Poll: `GET https://api2.cursor.sh/auth/poll?uuid&verifier` every 500ms, budget 180s.
  - 404 → continue
  - 403 with `{error}` → sign-in policy (auth, fail closed)
  - 200 `{accessToken, refreshToken}` → `{type:"oauth", access, refresh, expires}`
- `expires` = JWT `exp` in ms minus 5 minutes.
- Refresh: `POST https://api2.cursor.sh/oauth/token` JSON `{grant_type:"refresh_token", client_id:"KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB", refresh_token}` with `x-cursor-client-type: ide`. Keep the original refresh token. `shouldLogout: true` → auth error, re-login.
- Browser open is Pi’s `onAuth` callback; this provider does not fetch `cursor.com`.

---

## §8 Model catalog

Unary `application/proto` (not Connect-framed) against the same origin:

| RPC | request |
|---|---|
| `aiserver.v1.AiService/AvailableModels` | `use_model_parameters=true`, `do_not_use_markdown=true` |
| `aiserver.v1.AiService/GetUsableModels` | empty / no custom ids |
| `aiserver.v1.AiService/GetDefaultModelForCli` | empty |

Catalog unary uses CLI identity headers (`x-cursor-client-type: cli`, version `cli-2026.09.02-fa0c06e-lab`) because those RPCs are the CLI discovery surface.

Mapping: usable families ∩ available-model metadata. Distinct Max Mode → extra `-max` row with `samplingParams.cursorMaxMode=true`. Context window from variant `context` parameter (`Nk`/`Nm`) else captured token limit else 200_000. Output cap default 64_000. Cost rates 0 (no billed-cost field on RunInference).

TTL 600s in-process plus `context.publish({persist})`. Offline / failure → persisted cache then static fallback, with an explicit warning. A persisted snapshot where **no** row has `input` image is the pre-vision cache and is healed to `["text","image"]` until the next online refresh.

History truncation: if estimated tokens (`ceil(chars/4)`, images ≈1200 tokens each) exceed the selected model `contextWindow`, drop oldest non-system turns until under and emit a warning (diagnostics). System prompt is kept. The surviving replay always starts at a `user` turn — orphan `tool` results / assistant tool-call legs are dropped too.

---

## §9 Open items (PROTOCOL-U#)

| id | item | close condition |
|---|---|---|
| U1 | RunInference entitlement on this account | **Closed 2026-09-25**: live probe got HTTP 200 + Connect heartbeat, then trailer `permission_denied — InferenceService.RunInference is not enabled for this account`. Identity/headers/framing are fine; the account lacks the inference entitlement. |
| U2 | Linux/Windows identity vs IDE on this host | T-IDENT fixtures + one live header checksum accepted |
| U3 | unknown inner `InferenceStreamResponse` arms | currently fail-closed; record field number |
| U4 | `onPayload` replacement shape | replacement must remain our IR/request object or bytes we already produce |
| U5 | jsonSchema wrap | assumed `{jsonSchema: schema}` per IDE 3.18.9; live tool turn confirms |
| U6 | image input | **Closed 2026-09-26**: AgentService live user images via `UserMessage.selected_context` + MCP `McpImageContent`. RunInference still rejects images locally (no verified input field). |
| U7 | Grok thinking text | stream thinking if present; no synthesized summary |
| U8 | sessionId absence in headless | random conversation_id; full replay still sent |
| U9 | AgentService as second channel | **in v1** as `CURSOR_PROVIDER_CHANNEL=agent` (default). Not a silent RunInference fallback. Wire: PROTOCOL-AGENT.md. |
