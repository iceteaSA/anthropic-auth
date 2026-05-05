import {
  authorize,
  buildClaudeQuotaSummary,
  buildFallbackQuotaSummaries,
  CACHE_1H_COMMAND_NAME,
  CLAUDE_DUMP_COMMAND_NAME,
  CLAUDE_QUOTAS_COMMAND_NAME,
  CLIENT_ID,
  exchange,
  executeCache1hCommand,
  executeDumpCommand,
  FallbackAccountManager,
  fetchOAuthQuotaSnapshot,
  getCache1hMode,
  getCache1hPersistentMode,
  getQuotaCheckIntervalMs,
  getQuotaNextRefreshAt,
  getRelayConfig,
  isCache1hEnabled,
  isCache1hPersistentlyEnabled,
  isDumpPersistentlyEnabled,
  loadAccounts,
  type OAuthQuotaSnapshot,
  parseCache1hCommandAction,
  parseDumpCommandAction,
  type QuotaAccountSummary,
  quotaSnapshotPassesPolicy,
  type RelayConfig,
  sendViaRelay,
  setCache1hPersistentEnabled,
  setCache1hPersistentMode,
  setCache1hState,
  setDumpEnabled,
  setDumpPersistentEnabled,
  shouldFallbackStatus,
  TOKEN_URL,
} from '@cortexkit/anthropic-auth-core'
import type { Plugin } from '@opencode-ai/plugin'
import { resolvePromptContext } from './prompt-context.ts'
import {
  createStrippedStream,
  isInsecure,
  mergeHeaders,
  rewriteRequestBody,
  rewriteUrl,
  setOAuthHeaders,
} from './transform.ts'

const HANDLED_SENTINEL = '__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__'

type MainQuotaCache = {
  accessToken: string
  refreshAfter: number
  quota: OAuthQuotaSnapshot
}

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
  const { client } = ctx
  const fallbackManager = new FallbackAccountManager()
  fallbackManager.startBackgroundRefresh()
  const initialCache1hStorage = await loadAccounts()
  const relayConfig: RelayConfig | null = getRelayConfig(initialCache1hStorage)
  setCache1hState({
    enabled: isCache1hPersistentlyEnabled(initialCache1hStorage),
    mode: getCache1hPersistentMode(initialCache1hStorage),
  })
  setDumpEnabled(isDumpPersistentlyEnabled(initialCache1hStorage))
  let latestGetAuth:
    | (() => Promise<{
        type: string
        access?: string
        refresh?: string
        expires?: number
      }>)
    | null = null

  async function buildQuotaCommandSummary() {
    const accounts: QuotaAccountSummary[] = []
    if (latestGetAuth) {
      try {
        const auth = await latestGetAuth()
        if (auth.type === 'oauth' && auth.access) {
          accounts.push({
            name: 'OpenCode anthropic',
            role: 'main',
            quota: await fetchOAuthQuotaSnapshot({ accessToken: auth.access }),
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
        accounts.push({
          name: 'OpenCode anthropic',
          role: 'main',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    const { storage, errors } =
      await fallbackManager.refreshQuotaForAllAccounts()
    accounts.push(
      ...buildFallbackQuotaSummaries(
        storage,
        new Map(errors.map((error) => [error.accountId, error.message])),
      ),
    )

    if (!latestGetAuth) {
      accounts.unshift({
        name: 'OpenCode anthropic',
        role: 'main',
        error: 'auth loader has not run yet; send a request first',
      })
    }

    return buildClaudeQuotaSummary({ accounts, refreshedAt: Date.now() })
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
          let mainQuotaCache: MainQuotaCache | null = null
          let mainQuotaRefreshPromise: Promise<OAuthQuotaSnapshot> | null = null
          let mainQuotaRetryAfter = 0

          async function refreshMainAccessToken() {
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

                    const response = await fetch(TOKEN_URL, {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json, text/plain, */*',
                        'User-Agent': 'axios/1.13.6',
                      },
                      body: JSON.stringify({
                        grant_type: 'refresh_token',
                        refresh_token: freshAuth.refresh,
                        client_id: CLIENT_ID,
                      }),
                    })

                    if (!response.ok) {
                      if (response.status >= 500 && attempt < maxRetries) {
                        await response.body?.cancel()
                        continue
                      }

                      const body = await response.text().catch(() => '')
                      throw new Error(
                        `Token refresh failed: ${response.status} — ${body}`,
                      )
                    }

                    const json = (await response.json()) as {
                      refresh_token: string
                      access_token: string
                      expires_in: number
                    }

                    // biome-ignore lint/suspicious/noExplicitAny: SDK types don't expose auth.set
                    await (client as any).auth.set({
                      path: {
                        id: 'anthropic',
                      },
                      body: {
                        type: 'oauth',
                        refresh: json.refresh_token,
                        access: json.access_token,
                        expires: Date.now() + json.expires_in * 1000,
                      },
                    })

                    return json.access_token
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

          async function inspectStreamingRateLimit(response: Response) {
            if (!response.body || response.status !== 200) {
              return { response, rateLimited: false }
            }

            const reader = response.body.getReader()
            const chunks: Uint8Array[] = []
            const decoder = new TextDecoder()
            let text = ''

            while (!text.includes('\n\n') && text.length < 65_536) {
              const { done, value } = await reader.read()
              if (done) break
              chunks.push(value)
              text += decoder.decode(value, { stream: true })
              if (isStreamingRateLimitText(text)) break
            }

            if (isStreamingRateLimitText(text)) {
              await reader.cancel().catch(() => {})
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
          ) {
            const requestHeaders = mergeHeaders(input, init)
            const subagentRequest = isSubagentRequest(requestHeaders)
            requestHeaders.delete('x-parent-session-id')
            setOAuthHeaders(requestHeaders, accessToken)

            let body = init?.body
            if (body && typeof body === 'string') {
              body = await rewriteRequestBody(body, {
                cache1hEnabled: !subagentRequest && isCache1hEnabled(),
                cache1hMode: getCache1hMode(),
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

            const response = await sendViaRelay({
              config: relayConfig,
              input: rewritten.input,
              init,
              headers: requestHeaders,
              body,
              fallback: directFetch,
            })

            return response
          }

          async function refreshMainQuotaCache(
            accessToken: string,
            storage: Awaited<ReturnType<typeof loadAccounts>>,
          ) {
            const now = Date.now()
            const quota = await fetchOAuthQuotaSnapshot({ accessToken })
            mainQuotaCache = {
              accessToken,
              refreshAfter: getQuotaNextRefreshAt(quota, storage, now),
              quota,
            }
            return quota
          }

          function refreshMainQuotaCacheInBackground(
            accessToken: string,
            storage: Awaited<ReturnType<typeof loadAccounts>>,
          ) {
            const now = Date.now()
            if (mainQuotaRefreshPromise || now < mainQuotaRetryAfter) return
            mainQuotaRefreshPromise = refreshMainQuotaCache(
              accessToken,
              storage,
            )
              .catch((error) => {
                mainQuotaRetryAfter = now + getQuotaCheckIntervalMs(storage)
                throw error
              })
              .finally(() => {
                mainQuotaRefreshPromise = null
              })
            void mainQuotaRefreshPromise.catch(() => {})
          }

          async function getMainQuotaForRouting(
            accessToken: string,
            storage: Awaited<ReturnType<typeof loadAccounts>>,
          ) {
            const now = Date.now()
            if (mainQuotaCache?.accessToken !== accessToken) {
              return await refreshMainQuotaCache(accessToken, storage)
            }
            if (now >= mainQuotaCache.refreshAfter) {
              refreshMainQuotaCacheInBackground(accessToken, storage)
            }
            return mainQuotaCache.quota
          }

          async function tryUsableFallbackAccounts(
            input: string | URL | Request,
            init: RequestInit | undefined,
            accounts: Awaited<
              ReturnType<FallbackAccountManager['getUsableFallbackAccounts']>
            >,
            storage: Awaited<ReturnType<typeof loadAccounts>>,
            currentResponse?: Response,
          ) {
            if (!accounts.length) return currentResponse ?? null

            await currentResponse?.body?.cancel().catch(() => {})
            let lastResponse: Response | null = currentResponse ?? null

            for (const [index, account] of accounts.entries()) {
              const access = account.access
              if (!access) continue
              let response = await sendWithAccessToken(input, init, access)
              lastResponse = response
              let fallbackAgain = shouldFallbackStatus(response.status, storage)
              if (!fallbackAgain) {
                const inspected = await inspectStreamingRateLimit(response)
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
          ) {
            if (!isReplayableRequest(input, init?.body)) return mainResponse

            const storage = await loadAccounts()
            let currentResponse = mainResponse
            let shouldFallback = shouldFallbackStatus(
              currentResponse.status,
              storage,
            )
            if (!shouldFallback) {
              const inspected = await inspectStreamingRateLimit(currentResponse)
              currentResponse = inspected.response
              shouldFallback = inspected.rateLimited
            }
            if (!shouldFallback) {
              return currentResponse
            }

            const accounts =
              preselectedAccounts ??
              (await fallbackManager.getUsableFallbackAccounts())
            return (
              (await tryUsableFallbackAccounts(
                input,
                init,
                accounts,
                storage,
                currentResponse,
              )) ?? currentResponse
            )
          }

          return {
            apiKey: '',
            async fetch(input: string | URL | Request, init?: RequestInit) {
              const auth = await getAuth()
              if (auth.type !== 'oauth') return fetch(input, init)
              if (!auth.access || !auth.expires || auth.expires < Date.now()) {
                auth.access = await refreshMainAccessToken()
              }

              if (!auth.access) {
                throw new Error('OAuth access token is missing after refresh')
              }
              const storage = await loadAccounts()
              let preselectedFallbackAccounts:
                | Awaited<
                    ReturnType<
                      FallbackAccountManager['getUsableFallbackAccounts']
                    >
                  >
                | undefined
              if (
                isReplayableRequest(input, init?.body) &&
                mainQuotaRoutingEnabled(storage)
              ) {
                try {
                  const mainQuota = await getMainQuotaForRouting(
                    auth.access,
                    storage,
                  )
                  if (!quotaSnapshotPassesPolicy(mainQuota, storage)) {
                    preselectedFallbackAccounts =
                      await fallbackManager.getUsableFallbackAccounts()
                    const fallbackResponse = await tryUsableFallbackAccounts(
                      input,
                      init,
                      preselectedFallbackAccounts,
                      storage,
                    )
                    if (fallbackResponse) {
                      return createStrippedStream(fallbackResponse)
                    }
                  }
                } catch {
                  // Main quota checks should optimize routing, not break requests.
                }
              }
              const mainResponse = await sendWithAccessToken(
                input,
                init,
                auth.access,
              )
              const response = await tryFallbackAccounts(
                input,
                init,
                mainResponse,
                preselectedFallbackAccounts,
              )

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
