# PROTOCOL-AGENT.md

Status: v0.1 · 2026-09-25
Wire fact source for L4b (`src/agent/`, `src/proto/agent.ts`). Implementation that contradicts it is a defect.
Nothing here is copied from a third-party plugin into the product. Field numbers come from the reconstructed `agent.v1` surface used by Cursor CLI `AgentService/Run`.

---

## §0 Channel contract

- **Explicit, not a fallback.** `CURSOR_PROVIDER_CHANNEL=agent` (default) or `inference`. Switching is an env choice; the other RPC is never tried on failure.
- **Audit invariant:** this client never executes Cursor native tools. Local work is Pi tools via MCP projection (`provider_identifier=pi`).
- **Resume:** the Cursor remote conversation is the primary timeline. Locally we store a handle per Pi `sessionId` (`conversation_id` + checkpoint + blobs + user-text fingerprint). Fingerprint match: same `conversation_id`, overlay the checkpoint onto `conversation_state` (keeps turns/todos/file state; only the root prompt is replaced with current rules + workspace). Fingerprint mismatch / checkpoint unusable / resume blob miss: drop the handle, mint a new id, and replay the full `root_prompt_messages_json`.
- **U1 closed:** this account’s RunInference returns `permission_denied` after a valid Connect stream. AgentService is the working path for included-plan agent usage on this account. That is an entitlement split, not a documented exclusive mapping of “on-demand ↔ RunInference” vs “included ↔ AgentService”.

**VERIFY 2026-09-25:** `tools/probe-agent.ts` against this account: HTTP 200, frames `thinking,text,usage,done`, text `pong`.

---

## §1 Transport

- Default origin: `https://agentn.us.api5.cursor.sh`
- Override: `CURSOR_PROVIDER_AGENT_ORIGIN` (must match the allowlist in `src/transport/origin.ts`)
- RPC: `POST /agent.v1.AgentService/Run`
- Content-Type: `application/connect+proto`
- Headers: `connect-protocol-version: 1`, `te: trailers`
- Identity: CLI (`x-cursor-client-type: cli`, `x-cursor-client-version` = `CURSOR_CLI_VERSION`), `x-ghost-mode: true`
- HTTP/2 bidi. Client keeps the stream open across Pi tool rounds (MCP results are written on the same stream). A new user turn starts a new Run.
- Heartbeat: empty `ClientHeartbeat` (AgentClientMessage field 7) every 15s while the stream is open. HTTP/2 PING every 20s.
- Idle between **work** frames (text / thinking / exec / kv / query): 120s (`CURSOR_PROVIDER_IDLE_MS`). Heartbeats do not reset this. First work frame: 30s (`CURSOR_PROVIDER_FIRST_TOKEN_MS`).
- Connect frames on this RPC are **uncompressed**. Gzip here is ignored by the agent host and the turn parks after `getBlobArgs`.

Allowlisted HTTPS hosts (NFR-4):

| host | use |
|---|---|
| `api2.cursor.sh` | OAuth, catalog, RunInference |
| `agentn.<region?>.api5.cursor.sh` | AgentService |
| loopback `http://127.0.0.1` / `localhost` | tests only |

---

## §2 AgentClientMessage (oneof `message`)

| field | case | when |
|---|---|---|
| 1 | `run_request` | open a turn |
| 2 | `exec_client_message` | typed exec result (reject / MCP result / request-context) |
| 3 | `kv_client_message` | blob get/set reply |
| 5 | `exec_client_control_message` | `throw` (2) for unknown exec; `stream_close` (1) terminates EVERY native exec reply; `heartbeat` (3) keeps a parked exec warm (§5.1) |
| 6 | `interaction_response` | whitelist approve/reject |
| 7 | `client_heartbeat` | empty keep-alive |

`ExecClientControlMessage` oneof: `stream_close=1` `{id=1 uint32}`, `throw=2` `{id=1, error=2}`, `heartbeat=3` `{id=1}` (per-exec keep-alive for long runs; not yet needed — the run-level heartbeat covers the probe's short execs).

Do not send `prewarm_request` or `conversation_action` except as nested inside `run_request`.

### §2.1 AgentRunRequest

| field | name | value |
|---|---|---|
| 1 | `conversation_state` | see §3 |
| 2 | `action` | `user_message_action` (field 1) with current user text |
| 4 | `mcp_tools` | Pi tools, `provider_identifier="pi"` |
| 5 | `conversation_id` | from the local handle when resuming; new UUID on first turn or stale rebuild |
| 9 | `requested_model` | `{ model_id, max_mode, parameters? }` |

Do **not** set `custom_system_prompt` (field 8). Do **not** send `model_details` (field 3) together with `requested_model`.

`requested_model.parameters` is a repeated `{id=1, value=2}`. Two producers:

| id | source |
|---|---|
| `context` | the default variant's `parameterValues` (`256k` / `1m` / …) — already wired |
| the family's effort knob: `reasoning_effort` (grok), `reasoning` (gpt-5.x), `effort` + `thinking` (Claude) | the variant of the thinking level Pi selected |

**Effort is a parameter, not a model id.** Cursor publishes an effort variant both as a slug (`grok-4.7-high`, kept in `thinkingLevelMap` as the display/gating map) and as `AvailableModelVariant.legacySlug` + `parameterValues`. Sending that slug as `requested_model.model_id` is rejected (`not_found`, measured 2026-09-28); sending the variant's parameters is what actually selects the effort. The catalog joins usable model ids to `variants[].legacySlug` and stores the parameter set per level in `samplingParams.cursorParams`.

`UserMessage`: `text=1`, `message_id=2`, `selected_context=3` (optional; live images), `mode=4` (1), `selected_context_blob=10`, `correlation_id=17` (= message_id).

Live image input (current user turn): `SelectedContext.selected_images=1`. Each `SelectedImage` is `uuid=2`, `path=3`, `mime_type=7`, `data=8` (raw bytes, not base64). Pi `ImageContent.data` is decoded from base64 first. Allowed mime: png/jpeg/gif/webp/bmp. Oversize (>16 MiB/blob) fails closed.

`AgentRunRequest.client_supports_inline_images=19` is always true. Cursor ignores `SelectedImage.data` / `McpImageContent` unless this gate is set.

`selected_context_blob` is **not** a generated protobuf type. Handwritten: repeated bytes field 1 = root-prompt blob ids, string field 22 = `"pi"`. Store that blob in the in-memory blob store; send its sha256 id as `UserMessage.selected_context_blob`.

### §2.2 McpToolDefinition

| field | name |
|---|---|
| 1 | `name` (raw Pi tool name) |
| 2 | `description` |
| 3 | `input_schema` (serialized `google.protobuf.Value` of the JSON Schema) |
| 4 | `provider_identifier` = `"pi"` |
| 5 | `tool_name` (raw Pi tool name) |

Model-facing name in replayed history is `mcp_pi_<tool>`. Live `mcpArgs.tool_name` may arrive prefixed; strip `mcp_pi_` before matching Pi’s registry.

`McpArgs.args` is `map<string, bytes>` of protobuf `Value`.

---

## §3 ConversationStateStructure (prompt, not journal)

Cursor’s model prompt is `root_prompt_messages_json` (field 1): repeated 32-byte sha256 blob ids. Each blob is UTF-8 JSON of one AI-SDK message.

`turns` (field 8) is **state**, not prompt. On a **rebuild** this client sends an empty `turns` list. On **resume** it keeps the checkpoint’s journal **and** its `root_prompt_messages_json`, then **appends** current rules blobs (field 1) and replaces `previous_workspace_uris` (9) / `client_name` (22). It does not rebuild history from the Pi transcript. Checkpoints are persisted as the remote handle.

Required state fields we send:

| field | value |
|---|---|
| 1 | `root_prompt_messages_json` blob ids |
| 9 | `previous_workspace_uris` = `[file URL of process.cwd()]` |
| 10 | `mode` = 1 |
| 22 | `client_name` = `"pi"` |

### §3.1 Root prompt JSON

- Cursor drops `role:"system"`. Pi’s system prompt (+ local-tool policy text) is a **user** message: `<rules>\n…\n</rules>`.
- Historical user text: `<user_query>\n…\n</user_query>`. Historical user images: extra content parts `{type:"image", image:"data:<mime>;base64,<data>"}` (rebuild only; resume keeps remote images).
- Assistant tool calls replay as `{type:"tool-call", toolCallId, toolName:"mcp_pi_<name>", args}`.
- Tool results replay as `{type:"tool-result", toolCallId, toolName:"mcp_pi_<name>", result, isError?}`. Tool-result images: `experimental_content: [{type:"image", data, mimeType}]`.
- Current user turn is **not** in the prompt list; it is the `user_message_action` (images go on `UserMessage.selected_context`).
- Replayed tool-result text capped at 20_000 chars with an explicit truncation marker (not silent).

---

## §4 AgentServerMessage (oneof `message`)

| field | case | handling |
|---|---|---|
| 1 | `interaction_update` | text/thinking/token/turn_ended → IR; other inner cases ignored |
| 2 | `exec_server_message` | §5 policy table (**must answer**) |
| 3 | `conversation_checkpoint_update` | keep bytes as the remote handle (do not interpret) |
| 4 | `kv_server_message` | §6 blob Q&A |
| 5 | `exec_server_control_message` | `abort` informational |
| 7 | `interaction_query` | §7 whitelist |
| 8 | `ttft_breakdown` | ignore |

Any **other outer field** is protocol-drift (fail-closed).

### §4.1 InteractionUpdate inner oneof

| field | case | IR |
|---|---|---|
| 1 | `text_delta` | text delta (`text=1`) |
| 4 | `thinking_delta` | thinking delta |
| 8 | `token_delta` | output token count (usage.output +=) |
| 13 | `heartbeat` | reset idle |
| 14 | `turn_ended` | terminal for this Run if no pending MCP |

Unknown inner update fields are ignored (not exec). Parallel MCP tool calls are delivered via `exec_server_message`, not these updates.

**Streaming:** every IR event fans out to the Pi sink live (`AgentSessionOptions.onEvent`) as the frame arrives — text/thinking deltas render while the model thinks; the turn log (`result.events`) remains the replay/audit copy. `turn_ended` / debounced `toolUse` append a final `usage` + `done` event to both.

**Usage:** AgentService never reports input tokens, so the final `usage` carries `input = estimateTokens(ir)` (chars/4 over system prompt + history + tools; images ≈1200 tokens each, matching Pi's own estimator) plus `output` from `token_delta`. Pi's context-window accounting and auto-compaction key off the last assistant usage; reporting `input: 0` made Pi undercount the prompt by the whole history.

---

## §5 ExecServerMessage — completeness table

`id=1` (uint32), `exec_id=15` (string). Oneof `message`:

| field | case | decision |
|---|---|---|
| 2 | `shell_args` | reject `shell_result.rejected` (4) |
| 3 | `write_args` | reject `write_result.rejected` (6) |
| 4 | `delete_args` | reject `delete_result.rejected` (6) |
| 5 | `grep_args` | `grep_result.error` (2) |
| 7 | `read_args` | reject `read_result.rejected` (3) |
| 8 | `ls_args` | reject `ls_result.rejected` (3) |
| 9 | `diagnostics_args` | reject `diagnostics_result.rejected` (3) |
| 10 | `request_context_args` | **success** with env.workspace_paths + mcp tools only |
| 11 | `mcp_args` | lift to Pi `toolCall`; later `mcp_result.success` |
| 14 | `shell_stream_args` | `shell_stream.rejected` (5) |
| 16 | `background_shell_spawn_args` | `background_shell_spawn_result.rejected` (3) |
| 17 | `list_mcp_resources_exec_args` | rejected (3) |
| 18 | `read_mcp_resource_exec_args` | rejected (3) `{uri, reason}` |
| 20 | `fetch_args` | `fetch_result.error` (2) — **no local HTTP** |
| 21 | `record_screen_args` | `record_screen_result.failure` (4) |
| 22 | `computer_use_args` | `computer_use_result.error` (2) |
| 23 | `write_shell_stdin_args` | `write_shell_stdin_result.error` (2) |
| 32 | `reflect_args` | `reflect_result.error` (2) |
| 33 | `setup_vm_environment_args` | **throw** (result type has only success; do not fake it) |
| 34 | `truncated_tool_call_args` | `truncated_tool_call_result.error` (2) |
| 35 | `start_grind_execution_args` | error (2) |
| 36 | `start_grind_planning_args` | **ack** `start_grind_planning_result.success` (1, empty) — plan mode is a Cursor-side UI affordance, no local effect |
| other | unknown | `ExecClientControlMessage.throw` `{id, error}` |

`T-AGENT` enumerates this table; adding a case without a row fails the test.

Reject reason (fixed prefix + `No operation was performed`): **intent-mapped and concrete** — names the capability-ranked best Pi tool for that native case and embeds the original command/path, e.g. ``To run that command from Pi, call the MCP tool `mcp_pi_ctx_shell` with {"command": "vainfo --display drm"}``. Ranking signals, strongest first: exact alias (`bash`) → capability word in the tool **name** → (command intents) a command-ish property (`command`/`cmd`/`script`) in the tool's own **JSON schema** → capability word in the **description**. The schema/description layers are zero-maintenance — they adapt to any Pi tool naming because Pi ships both in the IR. The per-case capability vocabulary only changes when Cursor adds a native exec case, which the `T-AGENT` completeness table already forces a commit for. Total miss degrades to registration order + full list — never breaks. Unknown exec fields (future native tools) throw with the same concrete redirect. The root-prompt policy text carries the intent map ahead of the full tool list. Rationale (verified live on grok-4.7): a wall of 30 tool names does not redirect the model — it retries the native tool until the loop guard kills the turn; one named tool with a copy-pasteable call does. From `LOCAL_TOOL_ESCALATE_AFTER` misses on, the redirect hardens to `STOP calling Cursor native tools` plus a single imperative call.

**Discovery is the real failure mode (measured 2026-09-28, grok-4.7 + composer-2.5).** `run_request.mcp_tools` does surface to the model as Cursor *dynamic* tools in the MCP namespace `pi` — but they are not always present in the model's static tool list. A model that cannot see them does not fail loudly: it concludes Pi MCP tools are unavailable for the session and falls back to Cursor native tools until the loop guard kills the turn. On a write/multi-step task, composer-2.5 produced **zero** `mcp_args` this way while its own reasoning said `未在可用工具列表中直接找到 mcp_pi_fffind` … `当前会话可能无法使用 Pi MCP 工具`. Therefore the root-prompt policy text states the dynamic-tool path up front (namespace `pi`, `GetDynamicTools` / `CallDynamicTool`) and tells the model to look the tools up there rather than fall back. This is guidance only — it changes nothing about what the provider will execute.

`mcp_not_found` replies rank the available list by shared capability word with the requested name (Cursor forwards unregistered names like `sudo_exec` straight to exec — it does not validate against the run-request catalog).

`start_grind_planning_args` is deliberately **not** an error. It is Cursor's plan-mode affordance, not a local operation: nothing executes either way. Measured on grok-4.7 (2026-09-28), the error arm made the model re-request it — 8 consecutive requests, 4 of them inside a single response — until the loop guard killed the turn, whereas the empty success ack lets the model move on to real `mcp_args` calls. Same spirit as the `setup_vm_environment_args` query ack ("ack only, no VM"), which is contrasted with exec case 33, where the *result type has only success and the work is real*, so that one still throws.

The miss budget is **8 per model turn** and counts every request that did **not** become a real Pi MCP tool call: a native-tool reject, an `unknown` exec arm, an `mcp_args` naming a tool the run never advertised, and a plan-mode ack (served, but still not a Pi tool call — counting it keeps the budget a true bound on unproductive requests). A real `mcpArgs` lift resets it — the model did the right thing. Below the budget the request is answered in-band; at the budget the run fails closed (loop guard) and `nextStep` names the ranked command tool. From `LOCAL_TOOL_ESCALATE_AFTER` (3) misses on, the redirect text hardens into a single imperative instruction. Rationale: the earlier gap — `unknown` and `mcp_not_found` replies never counted — allowed a run to spin forever on those two paths.

`request_context` success: `RequestContext.env.workspace_paths` must equal `previous_workspace_uris`. `tools` = the same MCP list. No file contents, git, layouts.

### §5.1 Native exec translation (default behavior)

A native exec is translated to a regular Pi `tool_call` — capability-matched via `rankedTools`, never a hardcoded tool name — so Pi's permission system stays the execution authority; the Pi result is encoded back into the native shape on continuation. The reject path remains as the fallback for cases with no capable Pi tool and for untranslatable cases. `CURSOR_PROVIDER_NATIVE_EXEC=inproc` switches to probe-only in-process execution for wire validation (`tools/probe-native.ts --inproc`).

Measured live 2026-09-29 (grok-4.7 / composer-2.5 / claude-4.5-sonnet). Field numbers cross-checked against two independent MIT-licensed reconstructions of the same wire surface.

- **Every exec reply ends with `ExecClientControlMessage.stream_close{id}`** — single-result execs too, not just streams (this is what the reference client does). While a translated exec is parked on a Pi tool call, the provider sends `ExecClientHeartbeat{id}` every 3 s so a long Pi-side execution never trips a per-exec timeout.
- **grok-4.7 shells via `shell_stream_args`** (field 14; same `ShellArgs` payload as field 2). `ShellArgs`: command=1, working_directory=2, timeout=3 (int32, unit unverified — decoded for debug, never translated), tool_call_id=4, description=15 (string, e.g. "Run echo command"). No `start` (4) event: sending one stalls the turn. `ShellResult.success` = 1 `{command=1, working_directory=2, exit_code=3, stdout=5, stderr=6, execution_time=7}` (failure = 2, same shape + `aborted=11`).
- **Cursor's "Glob" is `grep_args` with an empty `pattern` and `glob` (field 3) set** (composer-2.5, claude-4.5-sonnet). The reconstructed proto's GrepArgs numbering disagrees with the live wire — decode by wire type, not assumed type. `GrepResult.success` = 1 `{pattern=1, path=2, output_mode=3, workspace_results=4 map<string,GrepUnionResult>}`; union `files=2` `{files=1, total_files=2}`, `content=3` `{matches=1 [{file=1, matches=2 [{line_number=1, content=2}]}], total_matched_lines=3}`.
- **ReadArgs is `{path=1, tool_call_id=2}` — no offset/limit on the live wire.** `ReadResult.success` = 1 `{path=1, content=2, total_lines=3, file_size=4, truncated=6}`. `WriteResult.success` = 1 `{path=1, lines_created=2, file_size=3}`. `DeleteResult.success` = 1 `{path=1, deleted_file=2 (string — the path again), file_size=3, prev_content=4}`.
- **Delete needs the real `file_size`**: a `DeleteResult.success` with `file_size` omitted (=0) is journaled by the backend (checkpoint + kv) but the turn then stalls forever; reporting the real pre-delete size completes it (the backend even echoes the size back to the model). `prev_content` is NOT required. Translation therefore runs a composite through the command tool — `sz=$(wc -c < PATH) && rm -- PATH && printf 'D0:%s\\n' "$sz"` — and the encoder reports the parsed size. `DeleteResult.success` = 1 `{path=1, deleted_file=2 (string — the path again), file_size=3, prev_content=4}`.
- **KV `set_blob_args` may carry `blob_id` without `blob_data`** (a dedup reference, observed right after a Delete result): ack it with `SetBlobResult` like any write, store only when data is present. Fail-closing on it kills the turn.
- **`ls_args` is live-unreachable**: no current model (grok-4.7, composer-2.5, claude-4.5-sonnet) is offered an LS tool; they use Glob or shell. `LsResult.success` = 1 `{directory_tree_root=1}`, node `{abs_path=1, children_dirs=2, children_files=3 {name=1}, children_were_processed=4, num_files=6}` (child dirs shallow) — per the reconstructed schema plus a second client's working shape, not live-verified.
- **Resume + `mcp_tools`** (`tools/probe-resume.ts`): the backend retains the registration across resume requests, so the provider omits field 4 on resume when the persisted handle's `toolsetKey` matches the current set (changed set → re-send; `CURSOR_PROVIDER_RESEND_MCP_ON_RESUME=1` forces re-send). Changing the tool set mid-conversation, including calling a tool first declared on the resume request, works: the "MCP server pi does not exist" incident (session 01a0eb0e, 2026-09-29) did **not** reproduce from a plain tool-set change.

---

## §6 KV blobs

`KvServerMessage`: `id=1`, oneof `get_blob_args=2` `{blob_id=1}`, `set_blob_args=3` `{blob_id=1, blob_data=2}`.

- Store is **process memory only**, 64 MiB total, 16 MiB per blob. No eviction (eviction punches holes Cursor still references).
- get miss: if this Run is a remote **resume**, treat as stale (drop handle, rebuild once). If it is already a rebuild, fail-closed (do not answer empty).
- Reply `KvClientMessage` with the same `id`.

Blob id = SHA-256 of content (32 raw bytes; map key = hex).

---

## §7 InteractionQuery whitelist

`id=1`. Oneof `query`:

| field | case | reply |
|---|---|---|
| 2 | `web_search_request_query` | approve (hosted; not local exec) |
| 3 | `ask_question_interaction_query` | `AskQuestionResult.error` |
| 4 | `switch_mode_request_query` | reject |
| 5 | `exa_search_request_query` | approve (hosted) |
| 6 | `exa_fetch_request_query` | approve (hosted) |
| 7 | `create_plan_request_query` | `CreatePlanResult.error` |
| 8 | `setup_vm_environment_args` | `SetupVmEnvironmentResult.success` empty (**ack only**, no VM) |
| 9 | unnamed hosted web-fetch (observed) | approve empty (same shape as ExaFetch approved) |
| other | unknown | protocol-drift; do not send an empty result (that is indistinguishable from approval) |

Approve arms are empty messages (field 1 of the response oneof). Hosted web/search runs on Cursor’s servers, not this process.

---

## §8 MCP continuation

1. `mcpArgs` → IR `tool_call` (complete) with stripped Pi name and decoded args object.
2. Debounce 150ms after the last `mcpArgs` in a burst, then end the Pi `streamSimple` with `stopReason=toolUse` **without** closing the HTTP/2 stream.
3. Next `streamSimple` with matching `toolResult`s sends `mcp_result.success` (`McpTextContent` plus zero or more `McpImageContent`, `is_error` from Pi). `McpImageContent`: `data=1` (bytes), `mime_type=2`.
4. A new trailing user message (user interrupted) destroys the parked stream and opens a new Run. If the handle fingerprint still matches, that Run **resumes** the remote conversation; otherwise it rebuilds.

`McpSuccess.content` is at least one text item. Tool result UTF-8 cap 512 KiB with an explicit truncation marker.

After writing `mcp_result`, the first-token watchdog is armed again. Heartbeats still do not count as work.

Each Pi `streamSimple` leg owns its own sink; the continuation call hands the live fan-out (`run.emit`) to the new sink before `mcp_result` is written, so the next leg streams into the new Pi stream. A stale-remote retry (resume → rebuild) emits a sink-internal `reset` event first so already-streamed deltas from the failed attempt are dropped from the final message.

---

## §10 Process-local lifecycle vs remote resume

Three clocks:

| Layer | Lifetime | What it stores |
|---|---|---|
| Pi session file | Across processes | Transcript **copy**. Tools, rewind, and audit read this. |
| Handle file (`~/.config/pi/agent/cursor-provider/handles/<sessionId>.json`, override `CURSOR_PROVIDER_HANDLE_DIR`) | Across processes | Remote handle: `conversation_id`, checkpoint bytes, blobs, user-text fingerprint. |
| In-process `runs` map | One HTTP/2 stream | Parked MCP round. Dropped on `turn_ended` (no pending MCP), user interrupt, abort, or process exit. |

Same Pi process, same user turn, tool calls: keep the stream, yield `toolUse` to Pi, write `mcp_result` on the same stream.

Same Pi process, next user message **or** new process / `pi resume`: empty `runs` map. If the handle fingerprint matches the completed user texts, resume the remote conversation (overlay checkpoint; do not re-inject history). Stale cases (rewind, edited user text, missing checkpoint, blob miss, remote `not_found`): drop the handle, mint a new `conversation_id`, rebuild from the Pi transcript.

Fingerprint is the SHA-256 of completed **user** texts **and** those users' image payloads (assistant wording must not false-stale; swapping the attached image must).

---

## §9 Errors

Connect trailer `error.code` → `CursorError.kind` as in PROTOCOL.md §2.2 (`unauthenticated`/`permission_denied` → auth except where the message is an entitlement we already classified). HTTP 401/403 → auth. Transport → network.

Unknown exec answered with throw still counts as handled for idle; the throw payload is the fail-closed signal to the model.
