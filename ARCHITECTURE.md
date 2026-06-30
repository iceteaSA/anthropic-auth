# Architecture

## Pattern Overview

**Overall:** Plugin/extension-based OAuth proxy architecture — a shared core library provides Claude Pro/Max OAuth logic, with two separate integration packages adapting it to different agent platforms (OpenCode plugin and Pi provider extension).

**Key Characteristics:**
- Shared core (`@cortexkit/anthropic-auth-core`) contains all OAuth, quota, cache, relay, and request-signing logic — no duplication between agent integrations
- OpenCode integration operates at the **fetch/request transform** layer: intercepts Anthropic fetch calls, rewrites URLs and request bodies, sanitizes system prompts, and strips tool-prefix on streaming responses
- Pi integration operates at the **provider override** layer: replaces Pi's built-in Anthropic provider with a CortexKit implementation that uses the same shared core
- Sidecar JSON files persist config, fallback accounts, and runtime state — separate from the host agent's own credential store
- All external Anthropic API interactions go through shared core modules: OAuth token exchange, quota API, Claude Code identity bootstrap, and relay Worker

## Layers

**@cortexkit/anthropic-auth-core (Shared Core):**
- Purpose: Reusable OAuth, account, quota, cache, relay, dump, SSE, and request-signing logic
- Location: `packages/core/src/`
- Contains: OAuth authorization/token exchange (`auth.ts`), account storage (`accounts.ts`), PKCE generation (`pkce.ts`), quota management (`quota-manager.ts`, `quotas.ts`), cache control (`cache1h.ts`, `cachekeep.ts`), relay protocol (`relay.ts`), dump capture (`dump.ts`), Claude Code identity and body signing (`claude-code.ts`, `cch.ts`), routing (`routing.ts`), killswitch thresholds (`killswitch.ts`), fast mode (`fast.ts`), model specs (`models.ts`), provider-error contract (`provider.ts`), logging-level command (`logging.ts`), shared command execution (`commands/account.ts`), and constants (`constants.ts`)
- Depends on: `xxhash-wasm` (for cch body signing), Node.js built-ins (`crypto`, `fs`, `os`)
- Used by: Both `@cortexkit/opencode-anthropic-auth` and `@cortexkit/pi-anthropic-auth`

**@cortexkit/opencode-anthropic-auth (OpenCode Plugin):**
- Purpose: OpenCode plugin that intercepts Anthropic fetch requests, provides CLI, TUI sidebar, and command modal dialogs
- Location: `packages/opencode/src/`
- Contains: Plugin entry point (`index.ts`), CLI (`cli.ts`), request transform/SSE stripping (`transform.ts`), system prompt sanitization (`sanitize-memo.ts`, `prompt-context.ts`), TUI sidebar widget (`tui.tsx`), TUI preferences (`tui-preferences.ts`), command modal dialogs (`tui/command-dialogs.tsx`), loopback RPC server/client for TUI IPC (`rpc/`)
- Depends on: `@cortexkit/anthropic-auth-core`, `@opencode-ai/plugin` (peer), `@opentui/core` + `@opentui/solid` + `solid-js` (TUI), `jsonc-parser` (TUI preferences)
- Used by: OpenCode agent (loaded as plugin + TUI plugin)

**@cortexkit/pi-anthropic-auth (Pi Extension):**
- Purpose: Pi package that registers a CortexKit Anthropic provider override under Pi's built-in `anthropic` provider ID
- Location: `packages/pi/src/`
- Contains: Extension entry point (`index.ts`), command registration (`commands.ts`), request body conversion (`convert.ts`), Pi-specific path resolution (`paths.ts`), streaming provider implementation (`stream.ts`)
- Depends on: `@cortexkit/anthropic-auth-core`, `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui` (all peer)
- Used by: Pi agent (loaded as Pi package). Wires the shared `claude-account` and `claude-logging` command helpers from core (`packages/core/src/commands/account.ts`, `packages/core/src/logging.ts`) to persistent account/log-level state

**End-to-End Tests:**
- Purpose: Integration tests for the full OpenCode plugin flow with mock Anthropic and relay servers
- Location: `packages/e2e-tests/`
- Contains: Test harness (`harness.ts`), mock servers (`mock-anthropic.ts`, `mock-relay.ts`), OpenCode runner (`opencode-runner.ts`), test files (`tests/tool-prefix.test.ts`)

## Data Flow

**OpenCode Request Lifecycle:**

1. **Plugin load** — OpenCode loads `@cortexkit/opencode-anthropic-auth` plugin, which starts background refresh timers, creates `QuotaManager` and `FallbackAccountManager`, initializes RPC server, and registers `auth.loader` + `provider.models` hooks — `packages/opencode/src/index.ts`
2. **Auth loader** — When OpenCode creates an Anthropic session, the plugin's `auth.loader` runs: captures the OAuth `getAuth` function, starts main token refresh background loop — `packages/opencode/src/index.ts` (AnthropicAuthPlugin → auth.loader)
3. **Command registration** — Plugin registers `/claude-cache`, `/claude-cachekeep`, `/claude-quota`, `/claude-dump`, `/claude-fast`, `/claude-routing`, `/claude-killswitch`, `/claude-account`, `/claude-logging` — `packages/opencode/src/index.ts` (config hook)
4. **Request interception** — OpenCode's fetch wrapper calls the plugin's hooks — `packages/opencode/src/index.ts` (experimental fetch wrapping)
5. **URL rewrite** — `rewriteUrl()` adds `?beta=true` to `/v1/messages` and overrides base URL when `ANTHROPIC_BASE_URL` is set — `packages/opencode/src/transform.ts`
6. **Request body rewrite** — `rewriteRequestBody()` strips trailing assistant messages, normalizes Fable/Mythos thinking, injects billing header, sanitizes system prompt (removes OpenCode identity), prepends Claude Code identity, applies cache strategy (explicit/automatic/hybrid), adds fast mode, prefixes tool names with `mcp_`, creates `cch` over serialized body — `packages/opencode/src/transform.ts`
7. **Routing** — `shouldFallbackStatus()` checks if response should trigger fallback; `FallbackAccountManager` iterates accounts in routing order (main-first or fallback-first), respecting quota policy and killswitch thresholds — `packages/core/src/routing.ts`, `packages/core/src/accounts.ts`
8. **Relay** — `sendViaRelay()` sends full or patched body to Cloudflare Worker, which streams Anthropic response back. The Worker reads `RELAY_PLAN` from its bindings and gates websocket transport + request logging on `paid` (free plans get HTTP-only and no log lines). Non-429/403 upstream errors are mirrored into the `RELAY_STATE` KV namespace (TTL 7d) for post-mortem debugging — `packages/core/src/relay.ts` (`WORKER_SCRIPT`)
9. **SSE stream** — Response body is wrapped in `createStrippedStream()` which reverses the tool name prefix in streaming SSE events — `packages/opencode/src/transform.ts`
10. **Sidebar update** — `writeSidebarState()` writes quota/routing/cache state to a JSON file read by the TUI sidebar widget (separate process via RPC) — `packages/opencode/src/sidebar-state.ts`

**Pi Request Lifecycle:**

1. **Extension load** — Pi loads `@cortexkit/pi-anthropic-auth` package, which calls `registerCommands()` and `pi.registerProvider("anthropic", ...)` — `packages/pi/src/index.ts`
2. **Provider registration** — Provider defines OAuth login/refresh functions (delegating to core's `authorize`/`exchange`/`refreshClaudeOAuthToken`) and a `streamSimple` function — `packages/pi/src/index.ts`
3. **Stream implementation** — `streamCortexKitAnthropic()` in `packages/pi/src/stream.ts` builds the Anthropic request, sends via relay or direct, handles fallback routing and cache keepalive
4. **Slash commands** — `/claude-*` commands registered in `packages/pi/src/commands.ts` reuse core command execution functions. `claude-account` and `claude-logging` delegate to the shared helpers in `packages/core/src/commands/account.ts` and `packages/core/src/logging.ts` so behavior stays identical to the OpenCode plugin

**Quota Refresh Flow:**
1. Background timer fires at `checkIntervalMinutes` (default 5) — `packages/core/src/quota-manager.ts`
2. `QuotaManager.refreshMain()` fetches `https://api.anthropic.com/api/oauth/usage` with the access token
3. On success: persists quota snapshot to sidecar state file, updates sidebar state — `packages/opencode/src/index.ts` (onMainQuotaFetched callback)
4. On 429: records backoff with `nextRetryAt` timestamp — prevents further refreshes during backoff — `packages/core/src/accounts.ts`
5. On 400 `invalid_grant`: marks the account as `needsReauth` (refresh token is permanently dead; preserved OAuth session cancels do not erase it) — `packages/core/src/accounts.ts`
6. Fallback accounts: `FallbackAccountManager` refreshes per-account quotas in background, persists to state, notifies sidebar. Routing falls through to fallbacks during main quota-refresh contention rather than blocking — `packages/opencode/src/index.ts`

**Cache Keepalive Flow:**
1. `CacheKeepManager` tracks recently used hybrid-cache sessions — `packages/core/src/cachekeep.ts`
2. ~5 minutes before the 1-hour cache TTL expires, sends a `max_tokens: 0` pre-warm request to extend the cache entry
3. Removes response-only fields (streaming, thinking, structured output, forced tool choice) from the pre-warm body

## Key Abstractions

**QuotaManager:**
- Purpose: Unified quota cache and API gateway for main + fallback accounts — deduplication, rate-limit backoff, staleness handling
- Location: `packages/core/src/quota-manager.ts`
- Pattern: Singleton instance shared by plugin and fallback manager; token-fingerprint aware to detect account switches

**FallbackAccountManager:**
- Purpose: Manages background token refresh and quota fetch for fallback OAuth/API accounts
- Location: `packages/core/src/accounts.ts`
- Pattern: Created per-plugin-instance; iterates accounts and schedules per-account refresh timers

**CacheKeepManager:**
- Purpose: Tracks hybrid-cache sessions and sends pre-warm requests before 1-hour TTL expiry
- Location: `packages/core/src/cachekeep.ts`
- Pattern: In-memory target tracking with configurable time window; supports up to 32 concurrent sessions

**AccountStorage (sidecar file):**
- Purpose: Persisted configuration and runtime state — fallback accounts, quotas, refresh backoff, killswitch settings, cache/relay config
- Location: `packages/core/src/accounts.ts`
- Pattern: JSON file on disk (`~/.config/opencode/anthropic-auth.json` for OpenCode, `~/.pi/agent/anthropic-auth.json` for Pi). Runtime state in separate `anthropic-auth-state.json` to avoid overwriting config. Atomic writes via temp + rename.

**rewriteRequestBody:**
- Purpose: Full Anthropic request body transform — handle various cache strategies, system sanitization, tool name prefixing, billing headers, and body signing
- Location: `packages/opencode/src/transform.ts`
- Pattern: Clean pipeline of idempotent transforms; returns the original body on any parse failure (fail-closed)

**SidebarState:**
- Purpose: Shared state file between OpenCode server process and TUI widget process for live quota/routing/cache display
- Location: `packages/opencode/src/sidebar-state.ts`
- Pattern: JSON file under `$TMPDIR`; server writes after each routing decision or quota refresh; TUI polls on interval. Per-account state carries `killed` (killswitch-blocked), `enabled` (disabled by `/claude-account`), and `needsReauth` (400 invalid_grant refresh permanently dead) flags; main state additionally carries `quotaBackedOff`/`refreshBackedOff` and `*Until` timestamps so the TUI can surface refresh contention and 401-armed refresh backoff distinctly

**RPC Server/Client:**
- Purpose: Loopback HTTP server for TUI ↔ OpenCode server IPC — modal dialogs and notification delivery
- Location: `packages/opencode/src/rpc/`
- Pattern: Bearer-authenticated HTTP server on `127.0.0.1`; port file + token written to disk for TUI process discovery

## Entry Points

**OpenCode Plugin:**
- Location: `packages/opencode/src/index.ts`
- Triggers: OpenCode loads the plugin on startup — registers hooks, starts background services
- Responsibilities: Plugin factory (`AnthropicAuthPlugin`), auth loading, command registration, fetch interception, sidecar config management, background refresh orchestration

**OpenCode CLI:**
- Location: `packages/opencode/src/cli.ts`
- Triggers: User runs `bunx @cortexkit/opencode-anthropic-auth <command>`
- Responsibilities: Fallback account login (OAuth + API key, including in-modal add-account flows via the server pending-state), account listing, relay setup (Cloudflare Worker provisioning — Worker PUT must bind `RELAY_PLAN`, `RELAY_TOKEN`, and `RELAY_STATE` together; the plan gates websocket transport and request logging on the Worker side)

**Pi Extension:**
- Location: `packages/pi/src/index.ts`
- Triggers: Pi loads the installed package on startup
- Responsibilities: Register Anthropic provider override, register slash commands

**TUI Sidebar Widget:**
- Location: `packages/opencode/src/tui.tsx`
- Triggers: OpenCode TUI loads the plugin from `tui.json`
- Responsibilities: Render quota/reporting sidebar with per-account killswitch indicators (`killed`, `needsReauth`, `quotaBackedOff`/`refreshBackedOff`), open command modal dialogs on `/claude-*` commands (including in-modal API-key + OAuth add-account flows with OSC-52 copyable authorize URLs), honor TUI preferences from `tui-preferences.jsonc`

## Error Handling

**Strategy:** Fail-closed on parse failures (returns original request body vs crashing); 429 backoff with exponential retry for token refresh; retryable stream errors detected and bubbled as synthetic `ECONNRESET` for retry by the caller; killswitch blocks requests before they hit the API when quota drops below configured thresholds. API-key fallback routes only trigger after confirmed quota exhaustion (stale cached quota never triggers them).

**ProviderHttpError contract:** Refresh and quota-fetch errors flow through a duck-typed `ProviderHttpError` shape (`packages/core/src/provider.ts`) — `{ status?, retryAfter?, isRefreshError? }` — instead of `instanceof` checks against provider-specific classes. The `isRefreshError` flag arms the refresh-backoff path independently of HTTP status, so non-401 refresh failures preserve backoff rather than falling through to the quota-cache update. Same contract classifies frontend-retryable 5xx responses.

## Cross-Cutting Concerns

**Logging:** Simple structured logger (`packages/core/src/logger.ts`) writing to `$TMPDIR/opencode-anthropic-auth.log`; relay diagnostics and performance tracing behind `OPENCODE_ANTHROPIC_AUTH_PERF=1` env flag

**Caching:** In-memory quota cache (`QuotaManager`) with staleness-based refresh logic; memoized system prompt sanitization (`sanitize-memo.ts`) with 8MB max; 1-hour Anthropic prompt cache managed via cache strategy (`cache1h.ts`, `cachekeep.ts`)

**Storage:** Sidecar JSON files for config + state (separate files to avoid config overwrite), JSONC preferences file for TUI (`tui-preferences.jsonc`), JSON state file for TUI sidebar IPC at `$TMPDIR/opencode-anthropic-auth/`

**Security:** OAuth tokens stored in sidecar state file (separate from config); relay uses shared secret token; RPC server uses bearer token; token refresh uses file locks to prevent races; no secrets stored in git
