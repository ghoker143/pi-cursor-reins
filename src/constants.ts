// SPDX-License-Identifier: AGPL-3.0-or-later
/** HTTPS origin for OAuth, catalog, RunInference. PROTOCOL §1 / NFR-4. */
export const CURSOR_ORIGIN = "https://api2.cursor.sh";
/** Default AgentService origin. PROTOCOL-AGENT §1. */
export const CURSOR_AGENT_ORIGIN = "https://agentn.us.api5.cursor.sh";

export const LOGIN_URL = "https://cursor.com/loginDeepControl";
export const POLL_PATH = "/auth/poll";
export const REFRESH_PATH = "/oauth/token";
export const REFRESH_CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";

export const RUN_INFERENCE_PATH = "/aiserver.v1.InferenceService/RunInference";
export const AGENT_RUN_PATH = "/agent.v1.AgentService/Run";
export const AI_SERVICE = "aiserver.v1.AiService";

export const CHANNEL_ENV = "CURSOR_PROVIDER_CHANNEL";
export const AGENT_ORIGIN_ENV = "CURSOR_PROVIDER_AGENT_ORIGIN";

export const CURSOR_IDE_VERSION = "3.18.9";
export const CURSOR_IDE_COMMIT = "2ba48ff3f7514cc4643c52ca9f7b3173d9b66130";
export const CURSOR_CLI_VERSION = "cli-2026.09.02-fa0c06e-lab";

export const PROVIDER_ID = "cursor";
export const PROVIDER_API = "cursor-provider";
export const PROVIDER_NAME = "Cursor";

export const CONNECT_MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const CONNECT_COMPRESS_MIN = 1024;
export const MAX_PENDING_INVOCATIONS = 64;

export const DEFAULT_RUN_READY_MS = 65_000;
export const DEFAULT_IDLE_MS = 120_000;
export const DEFAULT_FIRST_TOKEN_MS = 30_000;
export const CATALOG_TTL_MS = 600_000;
export const DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEFAULT_MAX_TOKENS = 64_000;

export const POLL_INTERVAL_MS = 500;
export const POLL_WINDOW_MS = 180_000;
export const REFRESH_DEADLINE_MS = 20_000;
export const EXPIRY_SKEW_MS = 5 * 60 * 1000;

export const TOKEN_ENV = "PI_CURSOR_TOKEN";
export const DEBUG_ENV = "CURSOR_PROVIDER_DEBUG";
export const DEBUG_LOG_FILE = ".cursor-provider-debug.log";

export const MAX_BLOB_STORE_BYTES = 64 * 1024 * 1024;
export const MAX_BLOB_BYTES = 16 * 1024 * 1024;
export const MAX_MCP_RESULT_CHARS = 512 * 1024;
export const MAX_REPLAYED_TOOL_RESULT_CHARS = 20_000;
/** Fail-closed budget for unanswered local/tool misses in one model turn. PROTOCOL-AGENT §5. */
export const MAX_LOCAL_TOOL_REJECTIONS = 8;
/** After this many misses the redirect text escalates to a hard, terminal instruction. */
export const LOCAL_TOOL_ESCALATE_AFTER = 3;
export const MCP_BURST_MS = 150;
export const CLIENT_HEARTBEAT_MS = 15_000;
export const H2_PING_MS = 20_000;
/** Failsafe for a run parked on a toolUse yield whose Pi side never comes back. */
export const DEFAULT_TOOLUSE_WATCHDOG_MS = 30 * 60 * 1000;

export const HANDLE_DIR_ENV = "CURSOR_PROVIDER_HANDLE_DIR";
export const MAX_CHECKPOINT_BYTES = 8 * 1024 * 1024;
