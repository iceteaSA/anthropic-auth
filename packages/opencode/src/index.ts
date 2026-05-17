import {
  authorize,
  buildClaudeQuotaSummary,
  buildFallbackQuotaSummaries,
  CACHE_1H_COMMAND_NAME,
  CLAUDE_DUMP_COMMAND_NAME,
  CLAUDE_FAST_COMMAND_NAME,
  CLAUDE_QUOTAS_COMMAND_NAME,
  ClaudeOAuthRefreshError,
  exchange,
  executeCache1hCommand,
  executeDumpCommand,
  executeFastModeCommand,
  executeKillswitchCommand,
  FallbackAccountManager,
  getCache1hMode,
  getCache1hPersistentMode,
  getKillswitchConfig,
  getRelayConfig,
  isCache1hEnabled,
  isCache1hPersistentlyEnabled,
  isDumpPersistentlyEnabled,
  isFastModeEnabled,
  isFastModePersistentlyEnabled,
  isFastModeSupportedModel,
  isKillswitchEnabled,
  KILLSWITCH_COMMAND_NAME,
  killswitchPassesPolicy,
  killswitchRetryAfterSeconds,
  loadAccounts,
  log,
  type OAuthQuotaSnapshot,
  parseCache1hCommandAction,
  parseDumpCommandAction,
  parseFastModeCommandAction,
  type QuotaAccountSummary,
  QuotaManager,
  quotaSnapshotPassesPolicy,
  type RelayConfig,
  refreshClaudeOAuthToken,
  resolveClaudeCodeIdentity,
  sendViaRelay,
  setCache1hPersistentEnabled,
  setCache1hPersistentMode,
  setCache1hState,
  setDumpEnabled,
  setDumpPersistentEnabled,
  setFastModeEnabled,
  setFastModePersistentEnabled,
  setKillswitchPersistent,
  shouldFallbackStatus,
} from '@cortexkit/anthropic-auth-core'
import type { Plugin } from '@opencode-ai/plugin'
import { resolvePromptContext } from './prompt-context.ts'
import {
  addFastModeBetaHeader,
  createStrippedStream,
  isInsecure,
  mergeHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from './transform.ts'

const HANDLED_SENTINEL = '__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__'
const MAIN_AUTH_REFRESH_TICK_MS = 60_000
const DEFAULT_MAIN_REFRESH_BEFORE_EXPIRY_MINUTES = 30
const MAIN_AUTH_REFRESH_429_INITIAL_BACKOFF_MS = 5 * 60_000
const MAIN_AUTH_REFRESH_429_MAX_BACKOFF_MS = 30 * 60_000

type NotificationRequest = {
  path: { id: string }
  body: {
    noReply: true
    parts: Array<{ type: 'text'; text: string; ignored: true }>
    agent?: string
    model?: { providerID: string; modelID: string }
    variant?: string
  }
}

type PluginSessionClient = {
  messages?: (input: {
    path: { id: string }
  }) =>
    | Promise<{ data?: unknown[] } | unknown[]>
    | { data?: unknown[] }
    | unknown[]
  prompt?: (input: NotificationRequest) => Promise<unknown> | unknown
  promptAsync?: (input: NotificationRequest) => Promise<unknown>
}

type PerfTrace = {
  requestId: string
  start: number
  last: number
  mark: (stage: string, data?: Record<string, unknown>) => void
  done: (stage: string, data?: Record<string, unknown>) => void
}

let nextPerfRequestId = 1
let eventLoopLagMonitorStarted = false

function nowMs() {
  return performance.now()
}

function roundMs(value: number) {
  return Math.round(value * 10) / 10
}

function startEventLoopLagMonitor() {
  if (eventLoopLagMonitorStarted || process.env.NODE_ENV === 'test') return
  eventLoopLagMonitorStarted = true
  const intervalMs = 100
  const thresholdMs = 250
  let expected = nowMs() + intervalMs
  setInterval(() => {
    const current = nowMs()
    const lag = current - expected
    expected = current + intervalMs
    if (lag < thresholdMs) return
    log('[perf] opencode event_loop_lag', {
      lagMs: roundMs(lag),
      thresholdMs,
    })
  }, intervalMs).unref?.()
}

function createPerfTrace(data?: Record<string, unknown>): PerfTrace {
  const start = nowMs()
  const trace: PerfTrace = {
    requestId: String(nextPerfRequestId++),
    start,
    last: start,
    mark(stage, stageData) {
      const current = nowMs()
      log('[perf] opencode request stage', {
        requestId: trace.requestId,
        stage,
        deltaMs: roundMs(current - trace.last),
        totalMs: roundMs(current - trace.start),
        ...stageData,
      })
      trace.last = current
    },
    done(stage, stageData) {
      const current = nowMs()
      log('[perf] opencode request done', {
        requestId: trace.requestId,
        stage,
        deltaMs: roundMs(current - trace.last),
        totalMs: roundMs(current - trace.start),
        ...stageData,
      })
      trace.last = current
    },
  }
  log('[perf] opencode request start', { requestId: trace.requestId, ...data })
  return trace
}

async function sendIgnoredMessage(
  ctx: Parameters<Plugin>[0],
  sessionId: string,
  text: string,
) {
  const session = ctx.client.session as PluginSessionClient | undefined
  const promptContext = await resolvePromptContext(ctx.client, sessionId)
  const request: NotificationRequest = {
    path: { id: sessionId },
    body: {
      noReply: true,
      parts: [{ type: 'text', text, ignored: true }],
    },
  }
  if (promptContext?.agent) request.body.agent = promptContext.agent
  if (promptContext?.model) request.body.model = promptContext.model
  if (promptContext?.variant) request.body.variant = promptContext.variant

  if (typeof session?.promptAsync === 'function') {
    await session.promptAsync(request)
    return
  }

  if (typeof session?.prompt === 'function') {
    await Promise.resolve(session.prompt(request))
    return
  }

  throw new Error(
    'OpenCode session prompt API is unavailable for ignored replies.',
  )
}

function throwHandledSentinel(): never {
  throw new Error(HANDLED_SENTINEL)
}

export const AnthropicAuthPlugin: Plugin = async (ctx) => {
  startEventLoopLagMonitor()
  const { client } = ctx
  const initialStorage = await loadAccounts()
  const quotaManager = new QuotaManager({ storage: initialStorage })
  const fallbackManager = new FallbackAccountManager({
    quotaManager,
  })
  fallbackManager.startBackgroundRefresh()
  const relayConfig: RelayConfig | null = getRelayConfig(initialStorage)
  setCache1hState({
    enabled: isCache1hPersistentlyEnabled(initialStorage),
    mode: getCache1hPersistentMode(initialStorage),
  })
  setDumpEnabled(isDumpPersistentlyEnabled(initialStorage))
  setFastModeEnabled(isFastModePersistentlyEnabled(initialStorage))
  let sessionRequestCount = 0

  function quotaBar(pct: number, width = 16): string {
    const filled = Math.round((pct / 100) * width)
    return '█'.repeat(filled) + '░'.repeat(width - filled)
  }

  /**
   * Show a toast notification with quota usage bars.
   *
   * `activeAccountId` marks which account is currently routable:
   *   - `'main'` → main account is active
   *   - a fallback ID → that fallback is active
   *   - omitted → no active indicator shown
   *
   * The optional `isKilled` callback allows killswitch integration
   * without coupling the toast to killswitch logic. When omitted,
   * no killed annotations are shown.
   */
  function showQuotaToast(
    quota: OAuthQuotaSnapshot | null,
    fallbacks?: Array<{
      id: string
      label?: string
      quota?: OAuthQuotaSnapshot
    }>,
    activeAccountId?: string,
    isKilled?: (
      quota: OAuthQuotaSnapshot | undefined,
      accountId?: string,
    ) => boolean,
  ) {
    const sections: string[] = []
    let globalMaxUsed = 0

    // Main account
    if (quota) {
      const fh = quota.five_hour
      const sd = quota.seven_day
      if (fh || sd) {
        const mainKilled = isKilled?.(quota) ?? false
        const mainActive = activeAccountId === 'main'
        const indicator = mainKilled ? '🔴' : mainActive ? '🟢' : '  '
        const lines: string[] = [`${indicator} main`]
        if (fh) {
          lines.push(
            `5h  ${quotaBar(fh.usedPercent)}  ${Math.round(fh.usedPercent)}%`,
          )
          globalMaxUsed = Math.max(globalMaxUsed, fh.usedPercent)
        }
        if (sd) {
          lines.push(
            `1w  ${quotaBar(sd.usedPercent)}  ${Math.round(sd.usedPercent)}%`,
          )
          globalMaxUsed = Math.max(globalMaxUsed, sd.usedPercent)
        }
        sections.push(lines.join('\n'))
      }
    }

    // Fallback accounts
    if (fallbacks?.length) {
      for (const fb of fallbacks) {
        const q = fb.quota
        if (!q) continue
        const fh = q.five_hour
        const sd = q.seven_day
        if (!fh && !sd) continue
        const name = fb.label || 'alt'
        const fbKilled = isKilled?.(q, fb.id) ?? false
        const fbActive = activeAccountId === fb.id
        const indicator = fbKilled ? '🔴' : fbActive ? '🟢' : '  '
        const lines: string[] = [`${indicator} ${name}`]
        if (fh) {
          lines.push(
            `5h  ${quotaBar(fh.usedPercent)}  ${Math.round(fh.usedPercent)}%`,
          )
          globalMaxUsed = Math.max(globalMaxUsed, fh.usedPercent)
        }
        if (sd) {
          lines.push(
            `1w  ${quotaBar(sd.usedPercent)}  ${Math.round(sd.usedPercent)}%`,
          )
          globalMaxUsed = Math.max(globalMaxUsed, sd.usedPercent)
        }
        sections.push(lines.join('\n'))
      }
    }

    if (!sections.length) return
    const message = sections.join('\n\n')
    const variant =
      globalMaxUsed >= 90 ? 'error' : globalMaxUsed >= 70 ? 'warning' : 'info'

    // biome-ignore lint/suspicious/noExplicitAny: SDK client.tui type not exposed to server plugins
    void (client.tui as any)
      ?.showToast?.({
        body: {
          title: 'Claude Quota',
          message,
          variant,
          duration: variant === 'error' ? 8000 : 5000,
        },
      })
      ?.catch?.(() => {})
  }
  let latestGetAuth:
    | (() => Promise<{
        type: string
        access?: string
        refresh?: string
        expires?: number
      }>)
    | null = null
  let mainBackgroundRefreshTimer: ReturnType<typeof setInterval> | null = null
  let mainRefreshBlockedUntil = 0
  let mainRefresh429BackoffMs = 0

  function mainRefreshCooldownRemainingMs(now = Date.now()) {
    return Math.max(0, mainRefreshBlockedUntil - now)
  }

  function noteMainRefreshRateLimited(
    error: ClaudeOAuthRefreshError,
    now = Date.now(),
  ) {
    // Always escalate backoff counter, even when Retry-After is present.
    // Prevents a server sending repeated short Retry-After values from
    // bypassing our exponential backoff (e.g. Retry-After: 30 every time).
    mainRefresh429BackoffMs =
      mainRefresh429BackoffMs === 0
        ? MAIN_AUTH_REFRESH_429_INITIAL_BACKOFF_MS
        : Math.min(
            mainRefresh429BackoffMs * 2,
            MAIN_AUTH_REFRESH_429_MAX_BACKOFF_MS,
          )

    const retryAfterMs =
      typeof error.retryAfter === 'number' && error.retryAfter > 0
        ? error.retryAfter * 1000
        : undefined

    // Use the larger of server's Retry-After and our backoff
    mainRefreshBlockedUntil =
      now + Math.max(retryAfterMs ?? 0, mainRefresh429BackoffMs)
  }

  function clearMainRefreshRateLimit() {
    mainRefresh429BackoffMs = 0
    mainRefreshBlockedUntil = 0
  }

  function mainRefreshBeforeExpiryMs(
    storage: Awaited<ReturnType<typeof loadAccounts>>,
  ) {
    const minutes =
      storage?.refresh?.refreshBeforeExpiryMinutes ??
      DEFAULT_MAIN_REFRESH_BEFORE_EXPIRY_MINUTES
    return Math.max(0, minutes) * 60_000
  }

  function mainRefreshEnabled(
    storage: Awaited<ReturnType<typeof loadAccounts>>,
  ) {
    return storage?.refresh?.enabled !== false
  }

  async function buildQuotaCommandSummary() {
    const accounts: QuotaAccountSummary[] = []
    if (latestGetAuth) {
      try {
        const auth = await latestGetAuth()
        if (auth.type === 'oauth' && auth.access) {
          // Use QuotaManager cache; eager fetch on first request means
          // this is always populated after the first API call.
          const cached = quotaManager.getMain()
          const quota =
            cached?.quota ?? (await quotaManager.refreshMain(auth.access))
          accounts.push({
            name: 'OpenCode anthropic',
            role: 'main',
            quota,
          })
        } else if (auth.type === 'oauth') {
          accounts.push({
            name: 'OpenCode anthropic',
            role: 'main',
            error:
              'missing access token; send a request first or reconnect auth',
          })
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        accounts.push({
          name: 'OpenCode anthropic',
          role: 'main',
          error: msg.includes('429')
            ? 'Usage API rate limited — try again in a moment'
            : msg,
        })
      }
    }

    // Prefer in-memory fallback quota cache; only live-fetch if no cache exists
    const storage = await loadAccounts()
    const fallbackEntries = quotaManager.getAllFallbacks()
    const hasCachedFallbacks = (storage?.accounts ?? []).some(
      (a) => a.enabled !== false && fallbackEntries.has(a.id),
    )
    if (hasCachedFallbacks) {
      // Overlay cached quota onto storage accounts for display
      for (const account of storage?.accounts ?? []) {
        const cached = fallbackEntries.get(account.id)
        if (cached) account.quota = cached.quota
      }
      accounts.push(...buildFallbackQuotaSummaries(storage, new Map()))
    } else {
      const { storage: refreshed, errors } =
        await fallbackManager.refreshQuotaForAllAccounts()
      accounts.push(
        ...buildFallbackQuotaSummaries(
          refreshed,
          new Map(errors.map((error) => [error.accountId, error.message])),
        ),
      )
    }

    if (!latestGetAuth) {
      accounts.unshift({
        name: 'OpenCode anthropic',
        role: 'main',
        error: 'auth loader has not run yet; send a request first',
      })
    }

    return buildClaudeQuotaSummary({
      accounts,
      refreshedAt: Date.now(),
      killswitch: storage?.killswitch ?? undefined,
      storage,
    })
  }

  async function executePersistentCache1hCommand(argumentsText: string) {
    const action = parseCache1hCommandAction(argumentsText)
    if (action.type === 'enable' || action.type === 'disable') {
      const enabled = action.type === 'enable'
      const storage = await setCache1hPersistentEnabled(enabled)
      const mode = getCache1hPersistentMode(storage)
      setCache1hState({ enabled, mode })
      return executeCache1hCommand({ argumentsText, enabled, mode })
    }

    if (action.type === 'mode') {
      const storage = await setCache1hPersistentMode(action.mode)
      const enabled = isCache1hPersistentlyEnabled(storage)
      setCache1hState({ enabled, mode: action.mode })
      return executeCache1hCommand({
        argumentsText,
        enabled,
        mode: action.mode,
      })
    }

    const storage = await loadAccounts()
    const enabled = isCache1hPersistentlyEnabled(storage)
    const mode = getCache1hPersistentMode(storage)
    setCache1hState({ enabled, mode })
    return executeCache1hCommand({ argumentsText, enabled, mode })
  }

  async function executePersistentDumpCommand(argumentsText: string) {
    const action = parseDumpCommandAction(argumentsText)
    if (action.type === 'enable' || action.type === 'disable') {
      const enabled = action.type === 'enable'
      await setDumpPersistentEnabled(enabled)
      setDumpEnabled(enabled)
      return executeDumpCommand({ argumentsText, enabled })
    }

    const storage = await loadAccounts()
    const enabled = isDumpPersistentlyEnabled(storage)
    setDumpEnabled(enabled)
    return executeDumpCommand({ argumentsText, enabled })
  }

  async function executePersistentFastModeCommand(argumentsText: string) {
    const action = parseFastModeCommandAction(argumentsText)
    if (action.type === 'enable' || action.type === 'disable') {
      const enabled = action.type === 'enable'
      await setFastModePersistentEnabled(enabled)
      setFastModeEnabled(enabled)
      return executeFastModeCommand({ argumentsText, enabled })
    }

    const storage = await loadAccounts()
    const enabled = isFastModePersistentlyEnabled(storage)
    setFastModeEnabled(enabled)
    return executeFastModeCommand({ argumentsText, enabled })
  }

  return {
    config: async (config: { command?: Record<string, unknown> }) => {
      config.command = {
        ...(config.command ?? {}),
        [CACHE_1H_COMMAND_NAME]: {
          template: CACHE_1H_COMMAND_NAME,
          description:
            'Show or toggle 1-hour Anthropic ephemeral prompt cache TTL.',
        },
        [CLAUDE_QUOTAS_COMMAND_NAME]: {
          template: CLAUDE_QUOTAS_COMMAND_NAME,
          description:
            'Show current Claude OAuth quota usage for all accounts.',
        },
        [CLAUDE_DUMP_COMMAND_NAME]: {
          template: CLAUDE_DUMP_COMMAND_NAME,
          description:
            'Show or toggle Anthropic request dump capture for debugging.',
        },
        [CLAUDE_FAST_COMMAND_NAME]: {
          template: CLAUDE_FAST_COMMAND_NAME,
          description:
            'Show or toggle Anthropic fast mode for supported Opus models.',
        },
        [KILLSWITCH_COMMAND_NAME]: {
          template: KILLSWITCH_COMMAND_NAME,
          description:
            'Manage killswitch — hard-block requests when quota drops below per-account thresholds.',
        },
      }
    },
    'command.execute.before': async (input: {
      command: string
      arguments: string
      sessionID: string
    }) => {
      if (input.command === CACHE_1H_COMMAND_NAME) {
        await sendIgnoredMessage(
          ctx,
          input.sessionID,
          await executePersistentCache1hCommand(input.arguments),
        )
        throwHandledSentinel()
      }

      if (input.command === CLAUDE_QUOTAS_COMMAND_NAME) {
        await sendIgnoredMessage(
          ctx,
          input.sessionID,
          await buildQuotaCommandSummary(),
        )
        throwHandledSentinel()
      }

      if (input.command === CLAUDE_DUMP_COMMAND_NAME) {
        await sendIgnoredMessage(
          ctx,
          input.sessionID,
          await executePersistentDumpCommand(input.arguments),
        )
        throwHandledSentinel()
      }

      if (input.command === CLAUDE_FAST_COMMAND_NAME) {
        await sendIgnoredMessage(
          ctx,
          input.sessionID,
          await executePersistentFastModeCommand(input.arguments),
        )
        throwHandledSentinel()
      }

      if (input.command === KILLSWITCH_COMMAND_NAME) {
        const storage = await loadAccounts()
        const config = getKillswitchConfig(storage)
        const accountIds = (storage?.accounts ?? [])
          .filter((a) => a.enabled !== false)
          .map((a) => a.id)
        const result = executeKillswitchCommand({
          argumentsText: input.arguments,
          config,
          accountIds,
        })
        if (result.updatedConfig) {
          await setKillswitchPersistent(result.updatedConfig)
        }
        await sendIgnoredMessage(ctx, input.sessionID, result.text)
        throwHandledSentinel()
      }
    },
    auth: {
      provider: 'anthropic',
      async loader(
        getAuth: () => Promise<{
          type: string
          access?: string
          refresh?: string
          expires?: number
        }>,
        provider: { models: Record<string, { cost: unknown }> },
      ) {
        latestGetAuth = getAuth
        const auth = await getAuth()
        if (auth.type === 'oauth') {
          // zero out cost for max plan
          for (const model of Object.values(provider.models)) {
            model.cost = {
              input: 0,
              output: 0,
              cache: {
                read: 0,
                write: 0,
              },
            }
          }

          // Shared inflight refresh promise — prevents concurrent token refreshes
          // from racing against each other (and causing 401 cascades with token rotation)
          let refreshPromise: Promise<string> | null = null

          async function refreshMainAccessToken() {
            const cooldownMs = mainRefreshCooldownRemainingMs()
            if (cooldownMs > 0) {
              throw new ClaudeOAuthRefreshError(
                429,
                `OAuth refresh temporarily rate-limited; retry in ${Math.ceil(
                  cooldownMs / 1000,
                )}s`,
                Math.ceil(cooldownMs / 1000),
              )
            }

            if (!refreshPromise) {
              refreshPromise = (async () => {
                const maxRetries = 2
                const baseDelayMs = 500

                for (let attempt = 0; attempt <= maxRetries; attempt++) {
                  try {
                    if (attempt > 0) {
                      const delay = baseDelayMs * 2 ** (attempt - 1)
                      await new Promise((resolve) => setTimeout(resolve, delay))
                    }

                    // Re-read auth to get the latest refresh token.
                    // The outer `auth` snapshot may be stale if tokens
                    // were rotated since the fetch() call was made.
                    const freshAuth = await getAuth()

                    if (!freshAuth.refresh) {
                      throw new Error(
                        'Token refresh failed: missing refresh token',
                      )
                    }

                    let refreshed: Awaited<
                      ReturnType<typeof refreshClaudeOAuthToken>
                    >
                    try {
                      refreshed = await refreshClaudeOAuthToken({
                        refreshToken: freshAuth.refresh,
                      })
                    } catch (error) {
                      if (
                        error instanceof ClaudeOAuthRefreshError &&
                        error.status === 429
                      ) {
                        noteMainRefreshRateLimited(error)
                        throw error
                      }
                      if (
                        error instanceof ClaudeOAuthRefreshError &&
                        error.status >= 500 &&
                        attempt < maxRetries
                      ) {
                        continue
                      }
                      throw error
                    }

                    // biome-ignore lint/suspicious/noExplicitAny: SDK types don't expose auth.set
                    await (client as any).auth.set({
                      path: {
                        id: 'anthropic',
                      },
                      body: {
                        type: 'oauth',
                        refresh: refreshed.refresh,
                        access: refreshed.access,
                        expires: refreshed.expires,
                      },
                    })

                    clearMainRefreshRateLimit()
                    return refreshed.access
                  } catch (error) {
                    const isNetworkError =
                      error instanceof Error &&
                      (error.message.includes('fetch failed') ||
                        ('code' in error &&
                          (error.code === 'ECONNRESET' ||
                            error.code === 'ECONNREFUSED' ||
                            error.code === 'ETIMEDOUT' ||
                            error.code === 'UND_ERR_CONNECT_TIMEOUT')))

                    if (attempt < maxRetries && isNetworkError) {
                      continue
                    }

                    throw error
                  }
                }
                // Unreachable — each iteration either returns or throws.
                // Kept as a TypeScript exhaustiveness guard.
                throw new Error('Token refresh exhausted all retries')
              })().finally(() => {
                refreshPromise = null
              })
            }

            return refreshPromise
          }

          function startMainBackgroundRefresh() {
            if (mainBackgroundRefreshTimer) {
              clearInterval(mainBackgroundRefreshTimer)
              mainBackgroundRefreshTimer = null
            }

            const run = async () => {
              try {
                const storage = await loadAccounts()
                if (!mainRefreshEnabled(storage)) return
                const latestAuth = await getAuth()
                if (latestAuth.type !== 'oauth') return
                if (!latestAuth.expires) return
                if (
                  latestAuth.expires - Date.now() >
                  mainRefreshBeforeExpiryMs(storage)
                ) {
                  return
                }

                const cooldownMs = mainRefreshCooldownRemainingMs()
                if (cooldownMs > 0) {
                  log('[refresh] opencode main oauth skipped during cooldown', {
                    retryInSeconds: Math.ceil(cooldownMs / 1000),
                  })
                  return
                }

                await refreshMainAccessToken()
                log('[refresh] opencode main oauth refreshed in background', {
                  expires: latestAuth.expires,
                })
              } catch (error) {
                if (
                  error instanceof ClaudeOAuthRefreshError &&
                  error.status === 429
                ) {
                  log('[refresh] opencode main oauth refresh rate limited', {
                    retryInSeconds: Math.ceil(
                      mainRefreshCooldownRemainingMs() / 1000,
                    ),
                  })
                  return
                }
                log('[refresh] opencode main oauth refresh failed', {
                  message:
                    error instanceof Error ? error.message : String(error),
                })
              }
            }

            mainBackgroundRefreshTimer = setInterval(() => {
              void run()
            }, MAIN_AUTH_REFRESH_TICK_MS)
            if ('unref' in mainBackgroundRefreshTimer) {
              mainBackgroundRefreshTimer.unref()
            }
          }

          startMainBackgroundRefresh()

          function isReplayableRequest(
            input: string | URL | Request,
            body: RequestInit['body'] | null | undefined,
          ) {
            if (input instanceof Request && input.body) return false
            return body == null || typeof body === 'string'
          }

          function isSubagentRequest(headers: Headers) {
            return headers.has('x-parent-session-id')
          }

          function isStreamingRateLimitText(text: string) {
            return (
              text.includes('rate_limit_error') ||
              /exceed your account'?s rate limit/i.test(text)
            )
          }

          function mainQuotaRoutingEnabled(
            storage: Awaited<ReturnType<typeof loadAccounts>>,
          ) {
            return storage?.quota?.enabled === true
          }

          async function inspectStreamingRateLimit(
            response: Response,
            trace?: PerfTrace,
          ) {
            if (!response.body || response.status !== 200) {
              trace?.mark('inspect_stream_skip', { status: response.status })
              return { response, rateLimited: false }
            }
            if (
              response.headers.get('x-cortexkit-relay-optimistic') === 'true'
            ) {
              trace?.mark('inspect_stream_skip', {
                status: response.status,
                reason: 'optimistic_relay',
              })
              return { response, rateLimited: false }
            }

            const start = nowMs()
            const reader = response.body.getReader()
            const chunks: Uint8Array[] = []
            const decoder = new TextDecoder()
            let text = ''
            let bytes = 0

            while (!text.includes('\n\n') && text.length < 65_536) {
              const { done, value } = await reader.read()
              if (done) break
              chunks.push(value)
              bytes += value.byteLength
              text += decoder.decode(value, { stream: true })
              if (isStreamingRateLimitText(text)) break
            }

            if (isStreamingRateLimitText(text)) {
              await reader.cancel().catch(() => {})
              trace?.mark('inspect_stream_first_event', {
                ms: roundMs(nowMs() - start),
                bytes,
                rateLimited: true,
              })
              return { response, rateLimited: true }
            }

            const stream = new ReadableStream({
              start(controller) {
                for (const chunk of chunks) controller.enqueue(chunk)
              },
              async pull(controller) {
                const { done, value } = await reader.read()
                if (done) {
                  controller.close()
                  return
                }
                controller.enqueue(value)
              },
              cancel(reason) {
                return reader.cancel(reason)
              },
            })

            trace?.mark('inspect_stream_first_event', {
              ms: roundMs(nowMs() - start),
              bytes,
              rateLimited: false,
            })
            return {
              response: new Response(stream, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              }),
              rateLimited: false,
            }
          }

          async function sendWithAccessToken(
            input: string | URL | Request,
            init: RequestInit | undefined,
            accessToken: string,
            trace?: PerfTrace,
            route = 'unknown',
          ) {
            log(`[route] sending via ${route}`)
            const start = nowMs()
            const requestHeaders = mergeHeaders(input, init)
            const relayAffinity =
              requestHeaders.get('x-session-affinity') ||
              requestHeaders.get('x-opencode-session')
            const subagentRequest = isSubagentRequest(requestHeaders)
            requestHeaders.delete('x-parent-session-id')
            requestHeaders.delete('x-session-affinity')
            requestHeaders.delete('x-opencode-session')
            let body = init?.body
            let modelForIdentity: string | undefined
            if (body && typeof body === 'string') {
              try {
                const parsedBody = JSON.parse(body) as { model?: unknown }
                if (typeof parsedBody.model === 'string') {
                  modelForIdentity = parsedBody.model
                }
              } catch {}
            }
            const identity = await resolveClaudeCodeIdentity(
              accessToken,
              modelForIdentity,
            )

            const originalBytes =
              typeof body === 'string' ? body.length : undefined
            if (body && typeof body === 'string') {
              const rewriteStart = nowMs()
              const fastModeRequested = (() => {
                if (!isFastModeEnabled()) return false
                try {
                  return isFastModeSupportedModel(JSON.parse(body).model)
                } catch {
                  return false
                }
              })()
              body = await rewriteRequestBody(body, {
                cache1hEnabled: !subagentRequest && isCache1hEnabled(),
                cache1hMode: getCache1hMode(),
                fastModeEnabled: fastModeRequested,
                identity,
              })
              try {
                setOAuthHeaders(requestHeaders, accessToken, {
                  body: JSON.parse(body),
                  identity,
                })
              } catch {
                setOAuthHeaders(requestHeaders, accessToken, { identity })
              }
              if (fastModeRequested) addFastModeBetaHeader(requestHeaders)
              trace?.mark('rewrite_body', {
                route,
                ms: roundMs(nowMs() - rewriteStart),
                originalBytes,
                rewrittenBytes: body.length,
                cacheEnabled: !subagentRequest && isCache1hEnabled(),
                cacheMode: getCache1hMode(),
                fastModeEnabled: fastModeRequested,
                subagent: subagentRequest,
              })
            }

            const rewritten = rewriteUrl(input)

            const directFetch = () =>
              fetch(rewritten.input, {
                ...init,
                body,
                headers: requestHeaders,
                ...(isInsecure() && { tls: { rejectUnauthorized: false } }),
              })

            const sendStart = nowMs()
            const response = await sendViaRelay({
              config: relayConfig,
              input: rewritten.input,
              init,
              headers: requestHeaders,
              body,
              fallback: directFetch,
              affinity: relayAffinity,
              optimisticResponse: relayConfig?.transport === 'websocket',
            })
            trace?.mark('send_headers_received', {
              route,
              ms: roundMs(nowMs() - sendStart),
              status: response.status,
              relayConfigured: relayConfig != null,
              totalSendWithAccessMs: roundMs(nowMs() - start),
            })

            return response
          }

          /**
           * Get the freshest quota for a fallback account from the shared
           * QuotaManager cache, falling back to the persisted snapshot.
           */
          function getFallbackQuota(account: {
            id: string
            quota?: OAuthQuotaSnapshot
          }): OAuthQuotaSnapshot | undefined {
            return quotaManager.getFallback(account.id)?.quota ?? account.quota
          }

          async function tryUsableFallbackAccounts(
            input: string | URL | Request,
            init: RequestInit | undefined,
            accounts: Awaited<
              ReturnType<FallbackAccountManager['getUsableFallbackAccounts']>
            >,
            storage: Awaited<ReturnType<typeof loadAccounts>>,
            currentResponse?: Response,
            trace?: PerfTrace,
          ) {
            if (!accounts.length) return currentResponse ?? null

            await currentResponse?.body?.cancel().catch(() => {})
            let lastResponse: Response | null = currentResponse ?? null

            for (const [index, account] of accounts.entries()) {
              const access = account.access
              if (!access) continue
              let response = await sendWithAccessToken(
                input,
                init,
                access,
                trace,
                `fallback_${index}`,
              )
              lastResponse = response
              let fallbackAgain = shouldFallbackStatus(response.status, storage)
              if (!fallbackAgain) {
                const inspected = await inspectStreamingRateLimit(
                  response,
                  trace,
                )
                response = inspected.response
                lastResponse = response
                fallbackAgain = inspected.rateLimited
              }
              if (!fallbackAgain) {
                await fallbackManager.markUsed(account)
                return response
              }
              if (index < accounts.length - 1) {
                await response.body?.cancel().catch(() => {})
              }
            }

            return lastResponse
          }

          async function tryFallbackAccounts(
            input: string | URL | Request,
            init: RequestInit | undefined,
            mainResponse: Response,
            preselectedAccounts?: Awaited<
              ReturnType<FallbackAccountManager['getUsableFallbackAccounts']>
            >,
            trace?: PerfTrace,
            existingStorage?: Awaited<ReturnType<typeof loadAccounts>>,
          ) {
            if (!isReplayableRequest(input, init?.body)) return mainResponse

            const loadStart = nowMs()
            const storage = existingStorage ?? (await loadAccounts())
            trace?.mark('fallback_load_storage', {
              ms: roundMs(nowMs() - loadStart),
              cached: !!existingStorage,
            })
            let currentResponse = mainResponse
            let shouldFallback = shouldFallbackStatus(
              currentResponse.status,
              storage,
            )
            if (!shouldFallback) {
              const inspected = await inspectStreamingRateLimit(
                currentResponse,
                trace,
              )
              currentResponse = inspected.response
              shouldFallback = inspected.rateLimited
            }
            if (!shouldFallback) {
              return currentResponse
            }

            let accounts = preselectedAccounts
            if (!accounts) {
              const accountsStart = nowMs()
              accounts =
                await fallbackManager.getUsableFallbackAccounts(storage)
              trace?.mark('fallback_get_accounts', {
                ms: roundMs(nowMs() - accountsStart),
                accounts: accounts.length,
              })
            }
            // Filter out killswitch-killed fallbacks
            if (isKillswitchEnabled(storage)) {
              const before = accounts.length
              accounts = accounts.filter((a) =>
                killswitchPassesPolicy(a.quota, storage, a.id),
              )
              if (accounts.length < before) {
                log('[killswitch] filtered fallbacks', {
                  before,
                  after: accounts.length,
                })
              }
            }
            return (
              (await tryUsableFallbackAccounts(
                input,
                init,
                accounts,
                storage,
                currentResponse,
                trace,
              )) ?? currentResponse
            )
          }

          return {
            apiKey: '',
            async fetch(input: string | URL | Request, init?: RequestInit) {
              sessionRequestCount++
              const initialBody = init?.body
              const trace = createPerfTrace({
                bodyBytes:
                  typeof initialBody === 'string'
                    ? initialBody.length
                    : undefined,
                relayConfigured: relayConfig != null,
              })
              const authStart = nowMs()
              const auth = await getAuth()
              trace.mark('get_auth', {
                ms: roundMs(nowMs() - authStart),
                authType: auth.type,
                hasAccess: Boolean(auth.access),
              })
              if (auth.type !== 'oauth') {
                const response = await fetch(input, init)
                trace.done('non_oauth_passthrough', { status: response.status })
                return response
              }
              if (!auth.access || !auth.expires || auth.expires < Date.now()) {
                const refreshStart = nowMs()
                auth.access = await refreshMainAccessToken()
                trace.mark('refresh_main_access', {
                  ms: roundMs(nowMs() - refreshStart),
                })
              }

              if (!auth.access) {
                trace.done('missing_access_error')
                throw new Error('OAuth access token is missing after refresh')
              }
              const loadStart = nowMs()
              const storage = await loadAccounts()
              quotaManager.updateStorage(storage)
              quotaManager.seedFallbacksFromAccounts(storage?.accounts ?? [])
              trace.mark('load_storage', { ms: roundMs(nowMs() - loadStart) })

              /** Show quota toast from current QuotaManager state */
              function showQuotaToastFromCache() {
                const mainEntry = quotaManager.getMain()
                if (!mainEntry) return
                const fallbacks = (storage?.accounts ?? []).filter(
                  (a) => a.enabled !== false,
                )
                const ksEnabled = isKillswitchEnabled(storage)
                const ksIsKilled = ksEnabled
                  ? (q: OAuthQuotaSnapshot | undefined, id?: string) =>
                      !killswitchPassesPolicy(q, storage, id)
                  : undefined
                const mainPassesPolicy = quotaSnapshotPassesPolicy(
                  mainEntry.quota,
                  storage,
                )
                const mainIsKilled = ksIsKilled?.(mainEntry.quota) ?? false
                let activeId: string | undefined
                if (!mainIsKilled && mainPassesPolicy) {
                  activeId = 'main'
                } else {
                  activeId = fallbacks.find(
                    (fb) => !(ksIsKilled?.(fb.quota, fb.id) ?? false),
                  )?.id
                }
                showQuotaToast(mainEntry.quota, fallbacks, activeId, ksIsKilled)
              }

              // Killswitch — hard-block before any API call if all accounts
              // are below their configured thresholds.
              // Eagerly fetch main quota on first request so killswitch can evaluate,
              // AND re-fetch when the cache is stale so killswitch can un-kill
              // accounts after their quota windows reset.
              if (isKillswitchEnabled(storage)) {
                const needsRefresh =
                  quotaManager.needsRefresh(sessionRequestCount)
                if (needsRefresh) {
                  try {
                    const ksQuotaStart = nowMs()
                    const fallbackAccts = (storage?.accounts ?? []).filter(
                      (a) => a.enabled !== false && a.access,
                    )
                    const reason = !quotaManager.getMain()
                      ? 'first_request'
                      : quotaManager.shouldRefreshOnRequestCount(
                            sessionRequestCount,
                          )
                        ? 'request_count'
                        : 'stale'
                    await Promise.all([
                      quotaManager.refreshMain(auth.access),
                      quotaManager.refreshAllFallbacks(fallbackAccts),
                    ])
                    trace.mark('killswitch_quota_refresh', {
                      ms: roundMs(nowMs() - ksQuotaStart),
                      reason,
                    })
                    showQuotaToastFromCache()
                  } catch {
                    // Best-effort — if quota fetch fails, use stale cache
                  }
                }
              }
              const mainQuota = quotaManager.getMain()?.quota
              if (isKillswitchEnabled(storage) && mainQuota) {
                const mainKilled = !killswitchPassesPolicy(mainQuota, storage)
                // Main is also unroutable if it's below the routing threshold
                const mainBelowRoutingThreshold =
                  mainQuotaRoutingEnabled(storage) &&
                  !quotaSnapshotPassesPolicy(mainQuota, storage)
                const mainUnroutable = mainKilled || mainBelowRoutingThreshold
                const fallbackAccounts = (storage?.accounts ?? []).filter(
                  (a) => a.enabled !== false,
                )
                const allFallbacksKilled =
                  fallbackAccounts.length === 0 ||
                  fallbackAccounts.every(
                    (a) =>
                      !killswitchPassesPolicy(
                        getFallbackQuota(a),
                        storage,
                        a.id,
                      ),
                  )

                log('[killswitch] check', {
                  mainKilled,
                  mainBelowRoutingThreshold,
                  allFallbacksKilled,
                  fallbackCount: fallbackAccounts.length,
                })

                if (mainUnroutable && allFallbacksKilled) {
                  const now = Date.now()
                  const retryAfter = killswitchRetryAfterSeconds(
                    mainQuota,
                    fallbackAccounts,
                    now,
                  )
                  const minutes = Math.floor(retryAfter / 60)
                  const seconds = retryAfter % 60
                  const timeStr =
                    minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`

                  log('[killswitch] no routable accounts', {
                    mainKilled,
                    mainBelowRoutingThreshold,
                    retryAfter,
                    requestId: trace.requestId,
                  })
                  trace.done('killswitch_blocked', { retryAfter })

                  // biome-ignore lint/suspicious/noExplicitAny: SDK client.tui type not exposed
                  void (client.tui as any)
                    ?.showToast?.({
                      body: {
                        title: 'Killswitch Active',
                        message: `No routable accounts${mainKilled ? ' (main killed)' : ' (main below routing threshold)'}\nAll fallbacks killed\nEarliest reset: ${timeStr}\nRetry-After: ${retryAfter}s`,
                        variant: 'error',
                        duration: 10000,
                      },
                    })
                    ?.catch?.(() => {})

                  return new Response(
                    JSON.stringify({
                      type: 'error',
                      error: {
                        type: 'rate_limit_error',
                        message: `Killswitch: no routable accounts (fallbacks killed${mainKilled ? ', main killed' : ', main below routing threshold'}). Retry in ${timeStr}.`,
                      },
                    }),
                    {
                      status: 429,
                      headers: {
                        'content-type': 'application/json',
                        'retry-after': String(retryAfter),
                      },
                    },
                  )
                }
              }

              // Track whether killswitch has killed main — used to skip main
              // in normal routing and reactive fallback paths below.
              const mainKillswitched =
                isKillswitchEnabled(storage) &&
                mainQuota != null &&
                !killswitchPassesPolicy(mainQuota, storage)

              // Helper: filter killswitch-killed accounts from a fallback list
              const filterKillswitchedFallbacks = <
                T extends { id: string; quota?: unknown },
              >(
                accounts: T[],
              ): T[] => {
                if (!isKillswitchEnabled(storage)) return accounts
                return accounts.filter((a) =>
                  killswitchPassesPolicy(
                    a.quota as Parameters<typeof killswitchPassesPolicy>[0],
                    storage,
                    a.id,
                  ),
                )
              }

              let preselectedFallbackAccounts:
                | Awaited<
                    ReturnType<
                      FallbackAccountManager['getUsableFallbackAccounts']
                    >
                  >
                | undefined

              // Killswitch: main is killed — route directly to surviving fallbacks
              if (mainKillswitched && isReplayableRequest(input, init?.body)) {
                log('[route] skipping main (killswitch), trying fallbacks')
                const fallbackStart = nowMs()
                const allFallbacks =
                  await fallbackManager.getUsableFallbackAccounts(storage)
                preselectedFallbackAccounts =
                  filterKillswitchedFallbacks(allFallbacks)
                trace.mark('preselect_fallback_accounts', {
                  ms: roundMs(nowMs() - fallbackStart),
                  accounts: preselectedFallbackAccounts.length,
                  filtered:
                    allFallbacks.length - preselectedFallbackAccounts.length,
                  reason: 'killswitch',
                })
                if (preselectedFallbackAccounts.length > 0) {
                  const fallbackResponse = await tryUsableFallbackAccounts(
                    input,
                    init,
                    preselectedFallbackAccounts,
                    storage,
                    undefined,
                    trace,
                  )
                  if (fallbackResponse) {
                    trace.done('return_preselected_fallback', {
                      status: fallbackResponse.status,
                      reason: 'killswitch',
                    })
                    return createStrippedStream(fallbackResponse)
                  }
                }
                // All surviving fallbacks failed — fall through to main as last resort
                log(
                  '[killswitch] surviving fallbacks exhausted, falling through to main',
                )
              }

              // Normal quota routing (independent of killswitch)
              if (
                isReplayableRequest(input, init?.body) &&
                mainQuotaRoutingEnabled(storage)
              ) {
                try {
                  const quotaStart = nowMs()
                  // Use QuotaManager: get cached or eagerly refresh if first time
                  let routingQuota = quotaManager.getMain()?.quota
                  if (!routingQuota) {
                    routingQuota = await quotaManager.refreshMain(auth.access)
                    showQuotaToastFromCache()
                  } else if (quotaManager.needsRefresh(sessionRequestCount)) {
                    // Background refresh — return stale to avoid blocking
                    quotaManager.refreshMainInBackground(auth.access)
                  }
                  trace.mark('main_quota_for_routing', {
                    ms: roundMs(nowMs() - quotaStart),
                    passes: quotaSnapshotPassesPolicy(routingQuota, storage),
                  })
                  if (!quotaSnapshotPassesPolicy(routingQuota, storage)) {
                    const fallbackStart = nowMs()
                    const allFallbacks =
                      await fallbackManager.getUsableFallbackAccounts(storage)
                    preselectedFallbackAccounts =
                      filterKillswitchedFallbacks(allFallbacks)
                    trace.mark('preselect_fallback_accounts', {
                      ms: roundMs(nowMs() - fallbackStart),
                      accounts: preselectedFallbackAccounts.length,
                      filtered:
                        allFallbacks.length -
                        preselectedFallbackAccounts.length,
                    })
                    const fallbackResponse = await tryUsableFallbackAccounts(
                      input,
                      init,
                      preselectedFallbackAccounts,
                      storage,
                      undefined,
                      trace,
                    )
                    if (fallbackResponse) {
                      trace.done('return_preselected_fallback', {
                        status: fallbackResponse.status,
                      })
                      return createStrippedStream(fallbackResponse)
                    }
                  }
                } catch (error) {
                  trace.mark('main_quota_for_routing_error', {
                    error:
                      error instanceof Error ? error.message : String(error),
                  })
                  // Main quota checks should optimize routing, not break requests.
                }
              }
              const mainResponse = await sendWithAccessToken(
                input,
                init,
                auth.access,
                trace,
                'main',
              )
              const response = await tryFallbackAccounts(
                input,
                init,
                mainResponse,
                preselectedFallbackAccounts,
                trace,
                storage,
              )

              trace.done('return_response', { status: response.status })

              return createStrippedStream(response)
            },
          }
        }

        return {}
      },
      methods: [
        {
          label: 'Claude Pro/Max',
          type: 'oauth',
          authorize: async () => {
            const result = await authorize('max')
            return {
              url: result.url,
              instructions: 'Paste the authorization code here:',
              method: 'code',
              callback: async (code: string) => {
                return exchange(
                  code,
                  result.verifier,
                  result.redirectUri,
                  result.state,
                )
              },
            }
          },
        },
        {
          label: 'Create an API Key',
          type: 'oauth',
          authorize: async () => {
            const result = await authorize('console')
            return {
              url: result.url,
              instructions: 'Paste the authorization code here:',
              method: 'code',
              callback: async (code: string) => {
                const credentials = await exchange(
                  code,
                  result.verifier,
                  result.redirectUri,
                  result.state,
                )
                if (credentials.type === 'failed') return credentials
                const apiKey = await fetch(
                  `https://api.anthropic.com/api/oauth/claude_cli/create_api_key`,
                  {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      authorization: `Bearer ${credentials.access}`,
                    },
                  },
                ).then((r) => r.json() as Promise<{ raw_key: string }>)
                return { type: 'success' as const, key: apiKey.raw_key }
              },
            }
          },
        },
        {
          provider: 'anthropic',
          label: 'Manually enter API Key',
          type: 'api',
        },
      ],
    },
    // biome-ignore lint/suspicious/noExplicitAny: Plugin type doesn't include undocumented auth/hooks
  } as any
}
