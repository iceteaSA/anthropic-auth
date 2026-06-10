import {
  applyClaudeCodeHeaders,
  applyClaudeCodeMetadata,
  buildBillingHeaderValue,
  type Cache1hMode,
  CLAUDE_CODE_ENTRYPOINT,
  CLAUDE_CODE_IDENTITY,
  CLAUDE_FABLE_MYTHOS_5_SUMMARIZED_THINKING,
  type ClaudeCodeIdentity,
  FAST_MODE_BETA,
  isClaudeFableOrMythos5Model,
  isFastModeSupportedModel,
  mergeAnthropicBetas,
  OPENCODE_IDENTITY_PREFIX,
  orderClaudeCodeBody,
  PARAGRAPH_REMOVAL_ANCHORS,
  REQUIRED_BETAS,
  signRequestBody,
  TEXT_REPLACEMENTS,
  TOOL_PREFIX,
} from '@cortexkit/anthropic-auth-core'
import { makeByteBoundedMemo } from './sanitize-memo'

/**
 * Prefix a tool name with TOOL_PREFIX and uppercase the first character.
 * Claude Code uses PascalCase tool names (e.g. mcp_Bash, mcp_Read);
 * lowercase names (mcp_bash, mcp_read) are flagged as non-Claude-Code clients.
 */
function prefixName(name: string): string {
  return `${TOOL_PREFIX}${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

/**
 * Reverse prefixName: strip TOOL_PREFIX and restore the original leading case.
 */
function unprefixName(name: string): string {
  // StructuredOutput is still used as StructuredOutput
  if (name === 'StructuredOutput') {
    return name
  }
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}`
}

const AFT_SUFFIX_TOOL_NAMES = new Set([
  'callgraph',
  'conflicts',
  'delete',
  'import',
  'inspect',
  'move',
  'navigate',
  'outline',
  'refactor',
  'safety',
  'search',
  'transform',
  'zoom',
])

function canonicalizeAftToolName(name: string): string | null {
  const normalized = unprefixName(name)
  if (normalized.startsWith('aft_')) return normalized
  if (AFT_SUFFIX_TOOL_NAMES.has(normalized)) return `aft_${normalized}`
  return null
}

export type FetchInput = string | URL | Request

/**
 * Merge headers from a Request object and/or a RequestInit headers value
 * into a single Headers instance.
 */
export function mergeHeaders(input: FetchInput, init?: RequestInit): Headers {
  const headers = new Headers()

  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      headers.set(key, value)
    })
  }

  const initHeaders = init?.headers
  if (initHeaders) {
    if (initHeaders instanceof Headers) {
      initHeaders.forEach((value, key) => {
        headers.set(key, value)
      })
    } else if (Array.isArray(initHeaders)) {
      for (const entry of initHeaders) {
        const [key, value] = entry as [string, string]
        if (typeof value !== 'undefined') {
          headers.set(key, String(value))
        }
      }
    } else {
      for (const [key, value] of Object.entries(initHeaders)) {
        if (typeof value !== 'undefined') {
          headers.set(key, String(value))
        }
      }
    }
  }

  return headers
}

/**
 * Merge incoming beta headers with the required OAuth betas, deduplicating.
 */
export function mergeBetaHeaders(headers: Headers): string {
  const incomingBeta = headers.get('anthropic-beta') || ''
  const incomingBetasList = incomingBeta
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean)

  return [...new Set([...REQUIRED_BETAS, ...incomingBetasList])].join(',')
}

export function addFastModeBetaHeader(headers: Headers): Headers {
  headers.set(
    'anthropic-beta',
    mergeAnthropicBetas(headers.get('anthropic-beta'), [FAST_MODE_BETA]),
  )
  return headers
}

/**
 * Set OAuth-required headers on the request: authorization, beta, user-agent.
 * Removes x-api-key since we're using OAuth.
 */
export function setOAuthHeaders(
  headers: Headers,
  accessToken: string,
  options: {
    body?: Record<string, unknown> | null
    identity?: ClaudeCodeIdentity
  } = {},
): Headers {
  return applyClaudeCodeHeaders(headers, accessToken, options)
}

/**
 * Add TOOL_PREFIX to tool names in the request body.
 * Prefixes both tool definitions and tool_use blocks in messages.
 */
export function prefixToolNames(parsed: Record<string, unknown>): string {
  if (parsed.tools && Array.isArray(parsed.tools)) {
    parsed.tools = parsed.tools.map(
      (tool: { name?: string; [k: string]: unknown }) => ({
        ...tool,
        name: tool.name ? prefixName(tool.name) : tool.name,
      }),
    )
  }

  if (parsed.messages && Array.isArray(parsed.messages)) {
    parsed.messages = parsed.messages.map(
      (msg: {
        content?: Array<{
          type: string
          name?: string
          [k: string]: unknown
        }>
        [k: string]: unknown
      }) => {
        if (msg.content && Array.isArray(msg.content)) {
          msg.content = msg.content.map((block) => {
            if (block.type === 'tool_use' && block.name) {
              return { ...block, name: prefixName(block.name) }
            }
            return block
          })
        }
        return msg
      },
    )
  }

  return JSON.stringify(orderClaudeCodeBody(parsed))
}

/**
 * Strip TOOL_PREFIX from tool names in streaming response text.
 */
export function stripToolPrefix(text: string): string {
  return text.replace(
    /"name"\s*:\s*"(mcp_)?([^"]+)"/g,
    (match, prefix: string | undefined, name: string) => {
      if (prefix) {
        return `"name": "${canonicalizeAftToolName(name) ?? unprefixName(name)}"`
      }

      const canonical = canonicalizeAftToolName(name)
      return canonical ? `"name": "${canonical}"` : match
    },
  )
}

function splitToolPrefixRewriteBuffer(buffer: string, flush = false) {
  if (flush) return { ready: stripToolPrefix(buffer), pending: '' }

  let keepFrom = buffer.length
  const marker = '"name"'
  const partialMarkerStart = Math.max(0, buffer.length - marker.length + 1)
  for (let index = partialMarkerStart; index < buffer.length; index++) {
    if (marker.startsWith(buffer.slice(index))) {
      keepFrom = Math.min(keepFrom, index)
      break
    }
  }

  const lastName = buffer.lastIndexOf(marker)
  if (lastName !== -1) {
    const tail = buffer.slice(lastName)
    if (/^"name"\s*(?::\s*(?:"[^"]*)?)?$/.test(tail)) {
      keepFrom = Math.min(keepFrom, lastName)
    }
  }

  if (keepFrom < buffer.length) {
    return {
      ready: stripToolPrefix(buffer.slice(0, keepFrom)),
      pending: buffer.slice(keepFrom),
    }
  }

  return { ready: stripToolPrefix(buffer), pending: '' }
}

/**
 * Check if TLS verification should be skipped for custom API endpoints.
 * Only effective when ANTHROPIC_BASE_URL is also set.
 */
export function isInsecure(): boolean {
  if (!process.env.ANTHROPIC_BASE_URL?.trim()) return false
  const raw = process.env.ANTHROPIC_INSECURE?.trim()
  return raw === '1' || raw === 'true'
}

/**
 * Parse ANTHROPIC_BASE_URL from the environment.
 * Returns a valid HTTP(S) URL or null if unset/invalid.
 */
function parseBaseUrl(raw: string | undefined): URL | null {
  const value = raw?.trim()
  if (!value) return null
  try {
    const baseUrl = new URL(value)
    if (
      (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') ||
      baseUrl.username ||
      baseUrl.password
    ) {
      return null
    }
    return baseUrl
  } catch {
    return null
  }
}

function resolveBaseUrl(): URL | null {
  return parseBaseUrl(process.env.ANTHROPIC_BASE_URL)
}

/**
 * Rewrite the request URL to add ?beta=true for /v1/messages requests.
 * When ANTHROPIC_BASE_URL is set, overrides the origin (protocol + host)
 * for all API requests flowing through the fetch wrapper.
 * Returns the modified input and URL (if applicable).
 */
export function rewriteUrl(
  input: FetchInput,
  options: { baseURL?: string } = {},
): {
  input: FetchInput
  url: URL | null
} {
  let requestUrl: URL | null = null
  try {
    if (typeof input === 'string' || input instanceof URL) {
      requestUrl = new URL(input.toString())
    } else if (input instanceof Request) {
      requestUrl = new URL(input.url)
    }
  } catch {
    requestUrl = null
  }

  if (!requestUrl) return { input, url: null }

  const originalHref = requestUrl.href

  const baseUrl = options.baseURL
    ? parseBaseUrl(options.baseURL)
    : resolveBaseUrl()
  if (baseUrl) {
    requestUrl.protocol = baseUrl.protocol
    requestUrl.host = baseUrl.host
    if (options.baseURL) {
      requestUrl.pathname = `${baseUrl.pathname.replace(/\/$/, '')}${requestUrl.pathname}`
    }
  }

  if (
    requestUrl.pathname.endsWith('/v1/messages') &&
    !requestUrl.searchParams.has('beta')
  ) {
    requestUrl.searchParams.set('beta', 'true')
  }

  if (requestUrl.href === originalHref) {
    return { input, url: requestUrl }
  }

  const newInput =
    input instanceof Request
      ? new Request(requestUrl.toString(), input)
      : requestUrl
  return { input: newInput, url: requestUrl }
}

/**
 * Sanitize OpenCode-branded strings from the system prompt text.
 *
 * 1. Removes the OPENCODE_IDENTITY paragraph.
 * 2. Removes any paragraph (text between blank lines) that contains
 *    one of the PARAGRAPH_REMOVAL_ANCHORS — typically URLs that
 *    identify OpenCode-specific content.
 * 3. Applies TEXT_REPLACEMENTS for inline occurrences of "OpenCode"
 *    inside paragraphs we want to keep.
 *
 * This approach is resilient to upstream rewording of the OpenCode
 * prompt — as long as the anchor strings (URLs, etc.) still appear
 * somewhere in the paragraph, the removal works.
 */
function _sanitizeSystemText(text: string): string {
  // Split into paragraphs (separated by one or more blank lines)
  const paragraphs = text.split(/\n\n+/)

  const filtered = paragraphs.filter((paragraph) => {
    if (paragraph.includes(OPENCODE_IDENTITY_PREFIX)) {
      // If the paragraph contains the identity, drop it entirely
      return false
    }

    // Remove paragraphs containing any removal anchor
    for (const anchor of PARAGRAPH_REMOVAL_ANCHORS) {
      if (paragraph.includes(anchor)) return false
    }

    return true
  })

  let result = filtered.join('\n\n')

  // Apply inline text replacements
  for (const rule of TEXT_REPLACEMENTS) {
    result = result.replace(rule.match, rule.replacement)
  }

  return result.trim()
}

const SANITIZE_MEMO_MAX_BYTES = 8 * 1024 * 1024

/** Memo on by default; OPENCODE_ANTHROPIC_AUTH_MEMO=0 disables (baseline). */
function sanitizeMemoEnabled(): boolean {
  return process.env.OPENCODE_ANTHROPIC_AUTH_MEMO !== '0'
}

const sanitizeSystemMemo = makeByteBoundedMemo(_sanitizeSystemText, {
  maxBytes: SANITIZE_MEMO_MAX_BYTES,
  enabled: sanitizeMemoEnabled,
})

/**
 * Sanitize a system-prompt block. Memoised: the prompt is stable within a
 * session, so the paragraph-filter + regex pass is skipped on cache hits.
 */
export function sanitizeSystemText(text: string): string {
  return sanitizeSystemMemo.call(text)
}

export function getSanitizeMemoStats() {
  return sanitizeSystemMemo.stats()
}

type SystemBlock = { type: string; text: string; [k: string]: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Sanitize system prompt and prepend Claude Code identity.
 * Handles all Anthropic API system formats: undefined, string, or array of text blocks.
 */
export function prependClaudeCodeIdentity(system: unknown): SystemBlock[] {
  const identityBlock: SystemBlock = {
    type: 'text',
    text: CLAUDE_CODE_IDENTITY,
  }

  if (system == null) return [identityBlock]

  if (typeof system === 'string') {
    const sanitized = sanitizeSystemText(system)
    if (sanitized === CLAUDE_CODE_IDENTITY) return [identityBlock]
    return [identityBlock, { type: 'text', text: sanitized }]
  }

  if (isRecord(system)) {
    const type = typeof system.type === 'string' ? system.type : 'text'
    const text = typeof system.text === 'string' ? system.text : ''
    return [identityBlock, { ...system, type, text: sanitizeSystemText(text) }]
  }

  if (!Array.isArray(system)) return [identityBlock]

  const sanitized: SystemBlock[] = system.map((item: unknown) => {
    if (typeof item === 'string') {
      return { type: 'text', text: sanitizeSystemText(item) }
    }

    if (
      isRecord(item) &&
      item.type === 'text' &&
      typeof item.text === 'string'
    ) {
      return {
        ...item,
        type: 'text',
        text: sanitizeSystemText(item.text),
      }
    }

    return { type: 'text', text: String(item) }
  })

  // Idempotency: don't double-prepend if first block already has the identity
  if (sanitized[0]?.text === CLAUDE_CODE_IDENTITY) {
    return sanitized
  }

  return [identityBlock, ...sanitized]
}

type CacheControl = { type: string; ttl?: string; [k: string]: unknown }
const CACHE_1H_CONTROL = { type: 'ephemeral', ttl: '1h' } as const
const ANTHROPIC_CACHE_LOOKBACK_BLOCKS = 20

function getCacheControl(value: Record<string, unknown>) {
  if (isRecord(value.cache_control)) return value.cache_control
  if (isRecord(value.cacheControl)) return value.cacheControl
  return null
}

function setWireCacheControl(value: unknown, withTtl: boolean) {
  if (!isRecord(value)) return false
  delete value.cacheControl
  value.cache_control = withTtl
    ? { ...CACHE_1H_CONTROL }
    : { type: 'ephemeral' }
  return true
}

function removeCacheControl(value: unknown) {
  if (!isRecord(value)) return
  delete value.cache_control
  delete value.cacheControl
}

function normalizeContentToArray(content: unknown) {
  if (Array.isArray(content)) return content
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return null
}

function updateCacheControlTtl(value: unknown, cache1hEnabled: boolean) {
  if (!isRecord(value)) return
  const cacheControl = getCacheControl(value) as CacheControl | null
  if (cacheControl?.type !== 'ephemeral') return

  if (cache1hEnabled) {
    cacheControl.ttl = '1h'
  } else {
    delete cacheControl.ttl
  }
}

function applyCache1hTtl(
  parsed: Record<string, unknown>,
  cache1hEnabled: boolean,
) {
  if (Array.isArray(parsed.system)) {
    for (const block of parsed.system)
      updateCacheControlTtl(block, cache1hEnabled)
  } else {
    updateCacheControlTtl(parsed.system, cache1hEnabled)
  }

  if (!Array.isArray(parsed.messages)) return

  for (const message of parsed.messages) {
    updateCacheControlTtl(message, cache1hEnabled)
    if (isRecord(message) && Array.isArray(message.content)) {
      for (const block of message.content) {
        updateCacheControlTtl(block, cache1hEnabled)
      }
    }
  }
}

function walkCacheControlTargets(
  parsed: Record<string, unknown>,
  visitor: (target: unknown) => void,
) {
  if (Array.isArray(parsed.system)) {
    for (const block of parsed.system) visitor(block)
  } else {
    visitor(parsed.system)
  }

  if (!Array.isArray(parsed.messages)) return

  for (const message of parsed.messages) {
    visitor(message)
    if (isRecord(message) && Array.isArray(message.content)) {
      for (const block of message.content) visitor(block)
    }
  }
}

function removeAllCacheControls(parsed: Record<string, unknown>) {
  removeCacheControl(parsed)
  walkCacheControlTargets(parsed, removeCacheControl)
}

function applyAutomaticCache1h(parsed: Record<string, unknown>) {
  removeAllCacheControls(parsed)
  parsed.cache_control = { ...CACHE_1H_CONTROL }
}

function isCacheableContentBlock(block: unknown) {
  return (
    isRecord(block) &&
    block.type !== 'thinking' &&
    block.type !== 'redacted_thinking'
  )
}

function getCacheableContentBlocks(message: Record<string, unknown>) {
  // cache_control is only valid on content blocks, never on the message
  // object itself. A message with no cacheable content block (empty content,
  // or only thinking/redacted_thinking blocks) must be skipped entirely;
  // attaching cache_control to the message triggers Anthropic's
  // "messages.N.cache_control: Extra inputs are not permitted" 400.
  const content = normalizeContentToArray(message.content)
  if (!content?.length) return undefined

  const cacheableBlocks = content.filter(isCacheableContentBlock)
  if (!cacheableBlocks.length) return undefined

  return { content, cacheableBlocks }
}

function setFirstMessageCacheAnchor(message: unknown) {
  if (!isRecord(message)) return false
  const cacheableContent = getCacheableContentBlocks(message)
  if (!cacheableContent) return false

  // Only materialize the normalized content array once we know we will anchor.
  message.content = cacheableContent.content
  return setWireCacheControl(cacheableContent.cacheableBlocks[0], true)
}

function setMessageCacheAnchor(message: unknown) {
  if (!isRecord(message)) return false
  const cacheableContent = getCacheableContentBlocks(message)
  if (!cacheableContent) return false

  const lastCacheableBlock =
    cacheableContent.cacheableBlocks[
      cacheableContent.cacheableBlocks.length - 1
    ]

  // Only materialize the normalized content array once we know we will anchor.
  message.content = cacheableContent.content
  return setWireCacheControl(lastCacheableBlock, true)
}

function hasMultipleCacheableContentBlocks(message: unknown) {
  if (!isRecord(message)) return false
  return (getCacheableContentBlocks(message)?.cacheableBlocks.length ?? 0) > 1
}

function messageContentBlockCount(message: unknown) {
  if (!isRecord(message)) return 0
  const content = message.content
  if (Array.isArray(content)) return content.length
  if (content == null) return 0
  return 1
}

function findUserCacheAnchors(messages: unknown[]) {
  const anchors: Array<{ index: number; blockPosition: number }> = []
  let blockPosition = 0

  messages.forEach((message, index) => {
    const blockCount = messageContentBlockCount(message)
    if (isRecord(message) && message.role === 'user' && blockCount > 0) {
      anchors.push({ index, blockPosition: blockPosition + blockCount - 1 })
    }
    blockPosition += blockCount
  })

  return anchors
}

function selectHybridMessageAnchors(messages: unknown[]) {
  const userAnchors = findUserCacheAnchors(messages)
  const latest = [...userAnchors].reverse().find((anchor) => anchor.index > 1)
  if (!latest) return { latest: undefined, bridge: undefined }

  const previous = [...userAnchors]
    .reverse()
    .find((anchor) => anchor.index < latest.index)
  const distanceFromPrevious = previous
    ? latest.blockPosition - previous.blockPosition + 1
    : 0
  const bridge =
    previous &&
    previous.index > 1 &&
    distanceFromPrevious > ANTHROPIC_CACHE_LOOKBACK_BLOCKS
      ? previous
      : undefined

  return { latest, bridge }
}

function setHybridSystemAnchor(parsed: Record<string, unknown>) {
  if (Array.isArray(parsed.system)) {
    const identityIndex = parsed.system.findIndex(
      (block) => isRecord(block) && block.text === CLAUDE_CODE_IDENTITY,
    )
    const cacheableSystemBlocks = parsed.system
      .slice(identityIndex >= 0 ? identityIndex + 1 : 0)
      .filter(isRecord)
    const lastSystemBlock =
      cacheableSystemBlocks[cacheableSystemBlocks.length - 1]
    setWireCacheControl(lastSystemBlock, true)
  } else {
    setWireCacheControl(parsed.system, true)
  }
}

function applyHybridCache1h(parsed: Record<string, unknown>) {
  removeAllCacheControls(parsed)

  if (!Array.isArray(parsed.messages)) {
    setHybridSystemAnchor(parsed)
    return
  }

  const { latest, bridge } = selectHybridMessageAnchors(parsed.messages)

  // Hybrid has only four Anthropic cache slots. Keep the system fallback in
  // normal turns, but spend that slot on the previous user/tool-result boundary
  // when a tool-heavy step pushes the latest user boundary outside Anthropic's
  // 20-block lookback window.
  if (!bridge) setHybridSystemAnchor(parsed)

  const firstMessageHasSplitPrefix = hasMultipleCacheableContentBlocks(
    parsed.messages[0],
  )
  if (firstMessageHasSplitPrefix) {
    setFirstMessageCacheAnchor(parsed.messages[0])
  }
  setMessageCacheAnchor(parsed.messages[0])
  if (!firstMessageHasSplitPrefix) setMessageCacheAnchor(parsed.messages[1])
  if (bridge) setMessageCacheAnchor(parsed.messages[bridge.index])
  if (latest) setMessageCacheAnchor(parsed.messages[latest.index])
}

function normalizeFableMythosRequest(
  parsed: Record<string, unknown>,
): { replacedExisting: boolean } | null {
  if (!isClaudeFableOrMythos5Model(parsed.model)) return null
  const hadThinking = Object.hasOwn(parsed, 'thinking')
  parsed.thinking = { ...CLAUDE_FABLE_MYTHOS_5_SUMMARIZED_THINKING }
  return { replacedExisting: hadThinking }
}

function applyCache1hStrategy(
  parsed: Record<string, unknown>,
  options: { enabled: boolean; mode: Cache1hMode },
) {
  if (!options.enabled) {
    applyCache1hTtl(parsed, false)
    delete parsed.cache_control
    delete parsed.cacheControl
    return
  }

  if (options.mode === 'automatic') {
    applyAutomaticCache1h(parsed)
    return
  }

  if (options.mode === 'hybrid') {
    applyHybridCache1h(parsed)
    return
  }

  applyCache1hTtl(parsed, true)
  delete parsed.cacheControl
}

/**
 * Strip trailing assistant messages. Anthropic rejects assistant-message
 * prefill on Claude Code OAuth models with: "This model does not support
 * assistant message prefill. The conversation must end with a user message."
 * A resumed/compacted session can end on an assistant turn (e.g. after a
 * failed tool round); pop those before signing.
 */
function stripTrailingAssistantMessages(parsed: Record<string, unknown>) {
  if (!Array.isArray(parsed.messages)) return
  while (parsed.messages.length) {
    const last = parsed.messages[parsed.messages.length - 1]
    if (!isRecord(last) || last.role !== 'assistant') break
    parsed.messages.pop()
  }
}

/**
 * Rewrite the full request body: sanitize system prompt and prefix tool names.
 */
type RewritePerfCallback = (
  stage: string,
  data?: Record<string, unknown>,
) => void

function rewriteNowMs() {
  return performance.now()
}

function rewriteRoundMs(value: number) {
  return Math.round(value * 10) / 10
}

function countRewriteShape(parsed: Record<string, unknown>) {
  let messageCount = 0
  let contentBlockCount = 0
  let toolUseCount = 0
  const messages = Array.isArray(parsed.messages) ? parsed.messages : []
  messageCount = messages.length
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const content = (message as { content?: unknown }).content
    if (!Array.isArray(content)) continue
    contentBlockCount += content.length
    for (const block of content) {
      if (
        block &&
        typeof block === 'object' &&
        (block as { type?: unknown }).type === 'tool_use'
      ) {
        toolUseCount++
      }
    }
  }
  return {
    messageCount,
    contentBlockCount,
    toolDefinitionCount: Array.isArray(parsed.tools) ? parsed.tools.length : 0,
    toolUseCount,
    systemBlockCount: Array.isArray(parsed.system) ? parsed.system.length : 0,
  }
}

export async function rewriteRequestBody(
  body: string,
  options: {
    cache1hEnabled?: boolean
    cache1hMode?: Cache1hMode
    fastModeEnabled?: boolean
    identity?: ClaudeCodeIdentity
    perf?: RewritePerfCallback
  } = {},
): Promise<string> {
  try {
    const parseStart = rewriteNowMs()
    const parsed = JSON.parse(body)
    options.perf?.('parse', {
      ms: rewriteRoundMs(rewriteNowMs() - parseStart),
      inputBytes: body.length,
      ...countRewriteShape(parsed),
    })

    const trailingStart = rewriteNowMs()
    const messagesBeforeStrip = Array.isArray(parsed.messages)
      ? parsed.messages.length
      : undefined
    stripTrailingAssistantMessages(parsed)
    const messagesAfterStrip = Array.isArray(parsed.messages)
      ? parsed.messages.length
      : undefined
    options.perf?.('strip_trailing_assistant', {
      ms: rewriteRoundMs(rewriteNowMs() - trailingStart),
      removedMessages:
        typeof messagesBeforeStrip === 'number' &&
        typeof messagesAfterStrip === 'number'
          ? messagesBeforeStrip - messagesAfterStrip
          : undefined,
    })

    const modelNormalizeStart = rewriteNowMs()
    const fableMythosThinking = normalizeFableMythosRequest(parsed)
    options.perf?.('model_normalize', {
      ms: rewriteRoundMs(rewriteNowMs() - modelNormalizeStart),
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      fableMythosThinkingDisplay: fableMythosThinking
        ? 'summarized'
        : undefined,
      replacedFableMythosThinking:
        fableMythosThinking?.replacedExisting ?? false,
      hasOutputConfig: Object.hasOwn(parsed, 'output_config'),
    })

    const billingStart = rewriteNowMs()
    const billingHeader =
      Array.isArray(parsed.messages) &&
      parsed.messages.some(
        (message: { role?: string }) => message.role === 'user',
      )
        ? buildBillingHeaderValue(
            parsed.messages,
            undefined,
            CLAUDE_CODE_ENTRYPOINT,
          )
        : null
    options.perf?.('billing_header', {
      ms: rewriteRoundMs(rewriteNowMs() - billingStart),
      hasBillingHeader: Boolean(billingHeader),
    })

    // Sanitize system prompt and prepend Claude Code identity
    const identityStart = rewriteNowMs()
    parsed.system = prependClaudeCodeIdentity(parsed.system)
    options.perf?.('system_identity', {
      ms: rewriteRoundMs(rewriteNowMs() - identityStart),
      systemBlockCount: Array.isArray(parsed.system) ? parsed.system.length : 0,
    })

    // Prepend the billing header as a separate system block so the
    // final layout is: [billing header, identity, ...rest]
    if (billingHeader && Array.isArray(parsed.system)) {
      parsed.system.unshift({ type: 'text', text: billingHeader })
    }

    const cacheStart = rewriteNowMs()
    applyCache1hStrategy(parsed, {
      enabled: options.cache1hEnabled ?? false,
      mode: options.cache1hMode ?? 'explicit',
    })
    options.perf?.('cache_strategy', {
      ms: rewriteRoundMs(rewriteNowMs() - cacheStart),
      enabled: options.cache1hEnabled ?? false,
      mode: options.cache1hMode ?? 'explicit',
    })

    if (options.fastModeEnabled && isFastModeSupportedModel(parsed.model)) {
      parsed.speed = 'fast'
    } else if (parsed.speed === 'fast') {
      delete parsed.speed
    }

    const metadataStart = rewriteNowMs()
    if (options.identity) applyClaudeCodeMetadata(parsed, options.identity)
    options.perf?.('metadata', {
      ms: rewriteRoundMs(rewriteNowMs() - metadataStart),
      hasAccountUuid: Boolean(options.identity?.accountUuid),
    })

    const prefixStart = rewriteNowMs()
    const prefixed = prefixToolNames(parsed)
    options.perf?.('prefix_tools_stringify', {
      ms: rewriteRoundMs(rewriteNowMs() - prefixStart),
      outputBytesBeforeSign: prefixed.length,
      ...countRewriteShape(parsed),
    })

    const signStart = rewriteNowMs()
    const signed = await signRequestBody(prefixed)
    options.perf?.('cch_sign', {
      ms: rewriteRoundMs(rewriteNowMs() - signStart),
      outputBytes: signed.length,
    })

    return signed
  } catch {
    return body
  }
}

type SseEventSummary = {
  event?: string
  type?: string
  index?: number
  contentBlockType?: string
  deltaType?: string
  stopReason?: string
  rawBytes: number
  dataBytes: number
  textDeltaBytes?: number
  thinkingDeltaBytes?: number
  inputJsonDeltaBytes?: number
  signatureDeltaBytes?: number
  redactedThinkingBytes?: number
}

type SseDiagnosticState = {
  pending: string
  events: number
  parseErrors: number
  eventCounts: Record<string, number>
  typeCounts: Record<string, number>
  deltaTypeCounts: Record<string, number>
  contentBlockTypeCounts: Record<string, number>
  textDeltaBytes: number
  thinkingDeltaBytes: number
  inputJsonDeltaBytes: number
  signatureDeltaBytes: number
  redactedThinkingBytes: number
  last?: SseEventSummary
}

const sseDiagnosticEncoder = new TextEncoder()

function createSseDiagnosticState(): SseDiagnosticState {
  return {
    pending: '',
    events: 0,
    parseErrors: 0,
    eventCounts: {},
    typeCounts: {},
    deltaTypeCounts: {},
    contentBlockTypeCounts: {},
    textDeltaBytes: 0,
    thinkingDeltaBytes: 0,
    inputJsonDeltaBytes: 0,
    signatureDeltaBytes: 0,
    redactedThinkingBytes: 0,
  }
}

function incrementCount(
  counts: Record<string, number>,
  key: string | undefined,
) {
  if (!key) return
  counts[key] = (counts[key] ?? 0) + 1
}

function stringBytes(value: string) {
  return sseDiagnosticEncoder.encode(value).byteLength
}

function asDiagnosticRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function stringField(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key]
  return typeof value === 'string' ? value : undefined
}

function numberField(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key]
  return typeof value === 'number' ? value : undefined
}

function summarizeSseEvent(rawEvent: string): SseEventSummary | null {
  if (!rawEvent.trim()) return null

  let eventName: string | undefined
  const dataLines: string[] = []
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      eventName = line.slice('event:'.length).trim()
      continue
    }
    if (line.startsWith('data:')) {
      const value = line.slice('data:'.length)
      dataLines.push(value.startsWith(' ') ? value.slice(1) : value)
    }
  }

  const dataText = dataLines.join('\n')
  const summary: SseEventSummary = {
    event: eventName,
    rawBytes: stringBytes(rawEvent),
    dataBytes: stringBytes(dataText),
  }

  if (!dataText || dataText === '[DONE]') {
    summary.type = dataText === '[DONE]' ? 'done' : undefined
    summary.event ??= summary.type
    return summary
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(dataText)
  } catch {
    return summary
  }

  const data = asDiagnosticRecord(parsed)
  const delta = asDiagnosticRecord(data?.delta)
  const contentBlock = asDiagnosticRecord(data?.content_block)
  const message = asDiagnosticRecord(data?.message)
  const usage =
    asDiagnosticRecord(data?.usage) ?? asDiagnosticRecord(message?.usage)

  summary.type = stringField(data, 'type')
  summary.event ??= summary.type
  summary.index = numberField(data, 'index')
  summary.contentBlockType = stringField(contentBlock, 'type')
  summary.deltaType = stringField(delta, 'type')
  summary.stopReason = stringField(data, 'stop_reason')

  if (summary.deltaType === 'text_delta') {
    summary.textDeltaBytes = stringBytes(stringField(delta, 'text') ?? '')
  }
  if (summary.deltaType === 'thinking_delta') {
    summary.thinkingDeltaBytes = stringBytes(
      stringField(delta, 'thinking') ?? '',
    )
  }
  if (summary.deltaType === 'input_json_delta') {
    summary.inputJsonDeltaBytes = stringBytes(
      stringField(delta, 'partial_json') ?? '',
    )
  }
  if (summary.deltaType === 'signature_delta') {
    summary.signatureDeltaBytes = stringBytes(
      stringField(delta, 'signature') ?? '',
    )
  }
  if (summary.contentBlockType === 'redacted_thinking') {
    summary.redactedThinkingBytes = stringBytes(
      stringField(contentBlock, 'data') ?? '',
    )
  }
  if (usage) {
    summary.stopReason ??= stringField(message, 'stop_reason')
  }

  return summary
}

function findSseBoundary(value: string) {
  const lf = value.indexOf('\n\n')
  const crlf = value.indexOf('\r\n\r\n')
  if (lf === -1) return crlf === -1 ? null : { index: crlf, length: 4 }
  if (crlf === -1 || lf < crlf) return { index: lf, length: 2 }
  return { index: crlf, length: 4 }
}

function updateSseDiagnostics(state: SseDiagnosticState, text: string) {
  if (!text) return
  state.pending += text

  while (true) {
    const boundary = findSseBoundary(state.pending)
    if (!boundary) break

    const rawEvent = state.pending.slice(0, boundary.index)
    state.pending = state.pending.slice(boundary.index + boundary.length)
    const summary = summarizeSseEvent(rawEvent)
    if (!summary) continue

    state.events++
    incrementCount(state.eventCounts, summary.event ?? 'unknown')
    incrementCount(state.typeCounts, summary.type)
    incrementCount(state.deltaTypeCounts, summary.deltaType)
    incrementCount(state.contentBlockTypeCounts, summary.contentBlockType)
    state.textDeltaBytes += summary.textDeltaBytes ?? 0
    state.thinkingDeltaBytes += summary.thinkingDeltaBytes ?? 0
    state.inputJsonDeltaBytes += summary.inputJsonDeltaBytes ?? 0
    state.signatureDeltaBytes += summary.signatureDeltaBytes ?? 0
    state.redactedThinkingBytes += summary.redactedThinkingBytes ?? 0
    state.last = summary
    if (summary.dataBytes > 0 && !summary.type && !summary.event) {
      state.parseErrors++
    }
  }
}

function sseDiagnosticStats(state: SseDiagnosticState) {
  return {
    sseEvents: state.events,
    ssePendingChars: state.pending.length,
    sseParseErrors: state.parseErrors,
    sseEventCounts: { ...state.eventCounts },
    sseTypeCounts: { ...state.typeCounts },
    sseDeltaTypeCounts: { ...state.deltaTypeCounts },
    sseContentBlockTypeCounts: { ...state.contentBlockTypeCounts },
    sseTextDeltaBytes: state.textDeltaBytes,
    sseThinkingDeltaBytes: state.thinkingDeltaBytes,
    sseInputJsonDeltaBytes: state.inputJsonDeltaBytes,
    sseSignatureDeltaBytes: state.signatureDeltaBytes,
    sseRedactedThinkingBytes: state.redactedThinkingBytes,
    sseLastEvent: state.last ? { ...state.last } : undefined,
  }
}

/**
 * Create a streaming response that strips the tool prefix from tool names.
 */
export function createStrippedStream(
  response: Response,
  options: { perf?: RewritePerfCallback } = {},
): Response {
  if (!response.body) return response

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ''
  let chunkCount = 0
  let pullCount = 0
  let inputBytes = 0
  let outputBytes = 0
  let rewriteMs = 0
  let firstPullLogged = false
  let readerReleased = false
  let lastProgressAt = rewriteNowMs()
  const streamStart = rewriteNowMs()
  const sseDiagnostics = options.perf ? createSseDiagnosticState() : undefined

  const releaseReader = () => {
    if (readerReleased) return
    readerReleased = true
    reader.releaseLock()
  }
  const streamStats = (extra: Record<string, unknown> = {}) => ({
    chunks: chunkCount,
    pulls: pullCount,
    inputBytes,
    outputBytes,
    pendingChars: pending.length,
    rewriteMs: rewriteRoundMs(rewriteMs),
    totalMs: rewriteRoundMs(rewriteNowMs() - streamStart),
    ...(sseDiagnostics ? sseDiagnosticStats(sseDiagnostics) : {}),
    ...extra,
  })
  const logProgress = (stage: string, extra: Record<string, unknown> = {}) => {
    options.perf?.(stage, streamStats(extra))
  }

  options.perf?.('stream_tool_prefix_wrapper_created', {
    status: response.status,
    hasBody: true,
  })

  const stream = new ReadableStream({
    async pull(controller) {
      pullCount++
      if (!firstPullLogged) {
        firstPullLogged = true
        logProgress('stream_tool_prefix_first_pull')
      }

      const readStart = rewriteNowMs()
      try {
        const { done, value } = await reader.read()
        const readMs = rewriteRoundMs(rewriteNowMs() - readStart)
        if (done) {
          const finalDecoded = decoder.decode()
          if (sseDiagnostics) updateSseDiagnostics(sseDiagnostics, finalDecoded)
          const rewriteStart = rewriteNowMs()
          const flushed = splitToolPrefixRewriteBuffer(
            `${pending}${finalDecoded}`,
            true,
          )
          rewriteMs += rewriteNowMs() - rewriteStart
          if (flushed.ready) {
            const encoded = encoder.encode(flushed.ready)
            outputBytes += encoded.byteLength
            controller.enqueue(encoded)
          }
          logProgress('stream_tool_prefix_rewrite', { readMs })
          releaseReader()
          controller.close()
          return
        }

        chunkCount++
        inputBytes += value.byteLength
        const decoded = decoder.decode(value, { stream: true })
        if (sseDiagnostics) updateSseDiagnostics(sseDiagnostics, decoded)
        const text = pending + decoded
        const rewriteStart = rewriteNowMs()
        const rewritten = splitToolPrefixRewriteBuffer(text)
        rewriteMs += rewriteNowMs() - rewriteStart
        pending = rewritten.pending
        if (rewritten.ready) {
          const encoded = encoder.encode(rewritten.ready)
          outputBytes += encoded.byteLength
          controller.enqueue(encoded)
        }

        const now = rewriteNowMs()
        if (
          chunkCount === 1 ||
          chunkCount % 25 === 0 ||
          now - lastProgressAt > 5000
        ) {
          lastProgressAt = now
          logProgress('stream_tool_prefix_progress', {
            readMs,
            lastChunkBytes: value.byteLength,
          })
        }
      } catch (error) {
        logProgress('stream_tool_prefix_error', {
          error: error instanceof Error ? error.message : String(error),
        })
        releaseReader()
        throw error
      }
    },
    async cancel(reason) {
      logProgress('stream_tool_prefix_cancel', {
        reason: reason instanceof Error ? reason.message : String(reason),
      })
      try {
        await reader.cancel(reason)
      } finally {
        releaseReader()
      }
    },
  })

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}
