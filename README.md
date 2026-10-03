# pi-cursor-reins

A [pi](https://github.com/earendil-works/pi) provider that runs Cursor models on your Cursor
subscription. Two channels, selected explicitly and never silently switched:

| channel | RPC | how |
|---|---|---|
| **agentic** (default) | `agent.v1.AgentService/Run` | Cursor orchestrates the conversation; all local work is pi's |
| **inference** | `aiserver.v1.InferenceService/RunInference` | opt-in via `CURSOR_PROVIDER_CHANNEL=inference`; requires the account entitlement |

The defining property: **no local operation happens outside pi.** On the agentic channel the
model and the conversation loop live on Cursor's side, but Cursor native tool-execution requests
(shell, read, write, delete, grep/Glob) are translated into ordinary pi tool calls —
capability-matched against the tools pi actually registered, never hardcoded — and executed under
pi's permission system; the result is encoded back into the native wire shape
([docs/PROTOCOL-AGENT.md](docs/PROTOCOL-AGENT.md) §5.1). Pi's other tools are projected to the
model as MCP tools (`provider_identifier=pi`). Native cases with no pi-side counterpart (fetch,
diagnostics, …) are still rejected case by case with a redirect; unknown protocol frames fail
closed. Hosted capabilities Cursor offers (web search/fetch) run on Cursor's servers and are
approved explicitly per query. On the inference channel there is no execution surface at all —
pure model in, tokens out.

## Why this exists

Actively maintained Cursor integrations for pi hand tool execution to the Cursor side; the two
audit-compliant implementations are unmaintained (survey in [docs/SPEC.md](docs/SPEC.md) §1.1).
This package maintains only the thin protocol layer and keeps local execution entirely inside
pi:

| Concern | Where it lives |
|---|---|
| Conversation memory / resume | Pi session file (copy) + Cursor remote handle. Resume the remote conversation; rebuild from the Pi transcript only when stale. |
| Tool execution | Pi tools + Pi permission system. Cursor native exec is translated to Pi tool calls (PROTOCOL-AGENT §5.1); untranslatable cases are rejected per case. No subprocess except documented host-identity commands. |
| Credentials | Pi `auth.json` only (`/login cursor`, auto-refresh). |
| Network | `https://api2.cursor.sh` (login, catalog, optional inference) and `https://agentn.*.api5.cursor.sh` (agent). Domain allowlist in code. |
| Identity commands | Documented allowlist in `src/identity` (Linux prefers reading machine-id files). |

## Install

```sh
pi install npm:pi-cursor-reins
```

Then:

```text
/login cursor    # Cursor OAuth, credentials stored in pi's auth.json
/model           # pick a cursor/… model
```

Headless: `pi -p --model cursor/<id> "…"`. Try `cursor/composer-2.5`, `cursor/grok-4.7`, or any
`cursor/…` row from `/model`.

## Usage notes

- **Same chat, many turns:** Cursor keeps the remote conversation. This provider stores a handle
  (`conversation_id` + checkpoint) next to Pi's transcript copy. The next user message resumes that
  remote conversation unless the local history looks stale (rewind, edited user text, missing
  blobs), in which case it rebuilds once from the Pi transcript.
- **`pi resume` / new process:** same rule. The HTTP/2 stream does not survive; the handle file does.
- **Stop / Ctrl+C:** pi abort closes the Run. The last complete-turn handle remains.
- **Vision:** Cursor `supportsImages` models advertise `images: yes` on the default channel. Attach
  via Pi (`@shot.png`, clipboard paste then `read`, or `type:"image"` parts). Paths/URLs typed as
  text are still just strings. RunInference does not accept images.
- **Thinking effort:** models with effort variants (`grok-4.7`, `gpt-5.x`, Claude) map Pi's
  reasoning level to Cursor's per-variant parameters.

## Compatibility

Tested host: **pi 0.99.x and 1.0.0** (peer range `>=0.99.0 <1.2.0`; deliberately narrow — widen only after live testing).
Node ≥ 22. No build step: pi loads `src/index.ts` via jiti.

This is an independent, unofficial implementation. It is not affiliated with Cursor, and Cursor may
change its protocols at any time — unknown wire events raise explicit errors rather than being
silently misread.

## Debug

`CURSOR_PROVIDER_DEBUG=1` writes a redacted request summary to `.cursor-provider-debug.log` in the
cwd. Slash command: `/cursor-provider` prints network / credential / identity / catalog-cache state
(no secrets).

Timeouts (ms): `CURSOR_PROVIDER_RUN_READY_MS` (65000), `CURSOR_PROVIDER_IDLE_MS` (120000),
`CURSOR_PROVIDER_FIRST_TOKEN_MS` (30000). Heartbeats do not reset the idle timer.
`CURSOR_PROVIDER_TOOLUSE_WATCHDOG_MS` (1800000) reaps a run whose tool results Pi never returns, so
a crashed Pi side cannot leak the stream.

If `pi -p` stays alive after the answer, that is another installed package holding the event loop.
This provider has already destroyed the AgentService stream. Confirm with
`pi -p --no-extensions -e <this-package> …`. On pi 0.99 `--no-extensions` also disables builtins
(mcp, llama.cpp, codemode).

When Pi hides declared bash/read/write (`codemode.mode=only`), native Shell/Read/Write/Grep still
execute: the provider synthesizes a `codemode` `{ code }` script. Default (`mode=on`) keeps the
direct declared-tool path.

## Development

```sh
npm test        # offline tests, no network
npm run typecheck
npm run audit   # spawn whitelist / egress domains / persistence inventory
```

Protocol fact sources: [docs/PROTOCOL.md](docs/PROTOCOL.md),
[docs/PROTOCOL-AGENT.md](docs/PROTOCOL-AGENT.md). Design: [docs/DESIGN.md](docs/DESIGN.md).
Requirements and audit criteria: [docs/SPEC.md](docs/SPEC.md).

## License

[AGPL-3.0-or-later](LICENSE) © 2026 ghoker143.
