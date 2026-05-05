import { Buffer } from 'node:buffer'
import { createHash, randomBytes } from 'node:crypto'
import type { AccountStorage } from './accounts.ts'
import { dumpRelayRequest } from './dump.ts'
import { relayLog } from './logger.ts'

export type RelayConfig = {
  enabled: boolean
  url: string
  token: string
  fallbackToDirect: boolean
  transport: 'http' | 'websocket'
}

export type RelayPatch = {
  start: number
  deleteCount: number
  insert: string
}

type RelayPatchSet = RelayPatch | RelayPatch[]

type RelaySessionState = {
  hash: string
  revision: number
  body: string
}

type RelayPayload = {
  protocol: 1 | 2
  type: 'request'
  id?: string
  affinity: string
  upstream: {
    url: string
    method: string
    headers: Record<string, string>
  }
  next_hash: string
  mode: 'full_sync' | 'patch'
  revision: number
  body?: string
  base_hash?: string
  patch?: RelayPatchSet
}

type RelayResponseStart = {
  type: 'response_start'
  id?: string
  status: number
  statusText?: string
  headers?: Record<string, string>
}

type RelayChunk = { type: 'chunk'; id?: string; base64: string }
type RelayDone = { type: 'done'; id?: string }
type RelayKeepalive = { type: 'keepalive' }
type RelayReady = {
  protocol: 2
  type: 'ready'
  state: { hash: string; revision: number } | null
}
type RelayAccepted = {
  protocol: 2
  type: 'accepted'
  id: string
  hash: string
  revision: number
}
type RelayErrorMessage = {
  type: 'error'
  id?: string
  status?: number
  message?: string
}
type RelayControlMessage =
  | RelayReady
  | RelayAccepted
  | RelayResponseStart
  | RelayChunk
  | RelayDone
  | RelayKeepalive
  | RelayErrorMessage

type RelaySendResult = {
  response: Response
  payload: RelayPayload
  transport: 'http' | 'websocket'
  protocol: 1 | 2
  usedRelay: boolean
}

class RelayStateMismatchError extends Error {}

const sessionState = new Map<string, RelaySessionState>()
const websocketSessions = new Map<string, PersistentRelaySession>()
const loggedRelayConfigMessages = new Set<string>()
let nextRequestId = 0

function createRequestId() {
  nextRequestId += 1
  return `req_${Date.now().toString(36)}_${nextRequestId.toString(36)}`
}

function logRelayConfigOnce(message: string): void {
  if (loggedRelayConfigMessages.has(message)) return
  loggedRelayConfigMessages.add(message)
  relayLog(message)
}

export function getRelayConfig(
  storage: AccountStorage | null,
): RelayConfig | null {
  const relay = storage?.relay
  if (!relay) {
    logRelayConfigOnce('disabled: no relay config found')
    return null
  }
  if (relay.enabled !== true) {
    logRelayConfigOnce('disabled: relay.enabled is not true')
    return null
  }
  if (!relay.url?.trim() || !relay.token?.trim()) {
    logRelayConfigOnce('disabled: missing relay url or token')
    return null
  }
  const transport = relay.transport === 'http' ? 'http' : 'websocket'
  logRelayConfigOnce(
    `configured transport=${transport} protocol=${transport === 'websocket' ? 2 : 1} url=${relay.url.trim()} fallbackToDirect=${relay.fallbackToDirect !== false}`,
  )
  return {
    enabled: true,
    url: relay.url.trim(),
    token: relay.token.trim(),
    fallbackToDirect: relay.fallbackToDirect !== false,
    transport,
  }
}

export function generateRelayToken() {
  return randomBytes(32).toString('base64url')
}

export function hashBody(body: string) {
  return `sha256:${createHash('sha256').update(body).digest('hex')}`
}

export function createStringPatch(previous: string, next: string): RelayPatch {
  let start = 0
  const maxPrefix = Math.min(previous.length, next.length)
  while (
    start < maxPrefix &&
    previous.charCodeAt(start) === next.charCodeAt(start)
  ) {
    start++
  }

  let previousEnd = previous.length
  let nextEnd = next.length
  while (
    previousEnd > start &&
    nextEnd > start &&
    previous.charCodeAt(previousEnd - 1) === next.charCodeAt(nextEnd - 1)
  ) {
    previousEnd--
    nextEnd--
  }

  return {
    start,
    deleteCount: previousEnd - start,
    insert: next.slice(start, nextEnd),
  }
}

function isNoopPatch(patch: RelayPatch) {
  return patch.deleteCount === 0 && patch.insert.length === 0
}

function findCchTokenRange(body: string) {
  const match = body.match(/\bcch=([0-9a-f]{5});/)
  const token = match?.[1]
  if (!token || match.index == null) return null
  const start = match.index + 'cch='.length
  return { start, end: start + token.length, token }
}

function replaceRange(
  text: string,
  start: number,
  end: number,
  replacement: string,
) {
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`
}

function createRelayPatch(previous: string, next: string): RelayPatchSet {
  const previousCch = findCchTokenRange(previous)
  const nextCch = findCchTokenRange(next)

  if (
    previousCch &&
    nextCch &&
    previousCch.start === nextCch.start &&
    previousCch.end - previousCch.start === nextCch.end - nextCch.start &&
    previousCch.token !== nextCch.token
  ) {
    const cchPatch = {
      start: previousCch.start,
      deleteCount: previousCch.end - previousCch.start,
      insert: nextCch.token,
    }
    const previousWithNextCch = replaceRange(
      previous,
      previousCch.start,
      previousCch.end,
      nextCch.token,
    )
    const tailPatch = createStringPatch(previousWithNextCch, next)
    return isNoopPatch(tailPatch) ? cchPatch : [cchPatch, tailPatch]
  }

  return createStringPatch(previous, next)
}

function isRelayableAnthropicRequest(
  input: string | URL | Request,
  body: unknown,
) {
  if (typeof body !== 'string') return false
  try {
    const url =
      input instanceof Request ? new URL(input.url) : new URL(input.toString())
    return url.pathname === '/v1/messages'
  } catch {
    return false
  }
}

function jsonHeaders(headers: Headers) {
  const result: Record<string, string> = {}
  for (const [key, value] of headers.entries()) result[key] = value
  return result
}

async function postRelay(
  config: RelayConfig,
  payload: RelayPayload,
): Promise<Response> {
  return fetch(config.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-relay-token': config.token,
    },
    body: JSON.stringify(payload),
  })
}

function shortAffinity(affinity: string) {
  return affinity.length > 12 ? `${affinity.slice(0, 12)}…` : affinity
}

function createRelayPayload(options: {
  input: string | URL | Request
  init: RequestInit | undefined
  headers: Headers
  bodyText: string
  affinity: string
  previous: RelaySessionState | undefined
  nextHash: string
}): RelayPayload {
  const { input, init, headers, bodyText, affinity, previous, nextHash } =
    options
  const rewrittenUrl = input instanceof Request ? input.url : input.toString()
  const basePayload = {
    protocol: 1 as const,
    type: 'request' as const,
    affinity,
    upstream: {
      url: rewrittenUrl,
      method:
        init?.method || (input instanceof Request ? input.method : 'POST'),
      headers: jsonHeaders(headers),
    },
    next_hash: nextHash,
  }

  return previous
    ? {
        ...basePayload,
        mode: 'patch',
        base_hash: previous.hash,
        revision: previous.revision + 1,
        patch: createRelayPatch(previous.body, bodyText),
      }
    : {
        ...basePayload,
        mode: 'full_sync',
        revision: 1,
        body: bodyText,
      }
}

function createFullSyncPayload(
  payload: RelayPayload,
  bodyText: string,
): RelayPayload {
  return {
    protocol: payload.protocol,
    type: 'request',
    affinity: payload.affinity,
    upstream: payload.upstream,
    next_hash: payload.next_hash,
    mode: 'full_sync',
    revision: 1,
    body: bodyText,
  }
}

function updateLocalRelayState(
  affinity: string,
  bodyText: string,
  nextHash: string,
  revision: number,
) {
  sessionState.set(affinity, {
    body: bodyText,
    hash: nextHash,
    revision,
  })
}

async function sendRelayHttp(options: {
  config: RelayConfig
  payload: RelayPayload
  bodyText: string
  fallback: () => Promise<Response>
}): Promise<RelaySendResult> {
  const { config, payload, bodyText, fallback } = options
  let actualPayload = payload
  let response = await postRelay(config, actualPayload)
  if (response.status === 409 && actualPayload.mode === 'patch') {
    relayLog(
      `state mismatch from relay session=${shortAffinity(actualPayload.affinity)}; retrying full_sync`,
    )
    await response.body?.cancel().catch(() => {})
    actualPayload = createFullSyncPayload(actualPayload, bodyText)
    response = await postRelay(config, actualPayload)
  }
  if (!response.ok && response.status >= 500 && config.fallbackToDirect) {
    relayLog(
      `relay returned ${response.status}; falling back direct session=${shortAffinity(actualPayload.affinity)}`,
    )
    await response.body?.cancel().catch(() => {})
    return {
      response: await fallback(),
      payload: actualPayload,
      transport: 'http',
      protocol: actualPayload.protocol,
      usedRelay: false,
    }
  }
  return {
    response,
    payload: actualPayload,
    transport: 'http',
    protocol: actualPayload.protocol,
    usedRelay: true,
  }
}

function toWebSocketUrl(url: string, token: string) {
  const parsed = new URL(url)
  parsed.protocol = parsed.protocol === 'http:' ? 'ws:' : 'wss:'
  parsed.pathname = '/ws'
  parsed.searchParams.set('token', token)
  return parsed.toString()
}

function decodeRelayChunk(base64: string) {
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

function parseRelayControlMessage(data: string): RelayControlMessage {
  return JSON.parse(data) as RelayControlMessage
}

type PendingWebSocketRequest = {
  payload: RelayPayload
  bodyText: string
  resolve: (response: Response) => void
  reject: (error: unknown) => void
  streamController?: ReadableStreamDefaultController<Uint8Array>
  streamDone: boolean
  accepted: boolean
  responseStarted: boolean
  timeout?: ReturnType<typeof setTimeout>
  resolveDone: () => void
  rejectDone: (error: unknown) => void
}

class PersistentRelaySession {
  private socket?: WebSocket
  private connecting?: Promise<void>
  private queue: Promise<void> = Promise.resolve()
  private pending?: PendingWebSocketRequest
  private serverState: { hash: string; revision: number } | null | undefined

  constructor(
    private readonly config: RelayConfig,
    private readonly affinity: string,
  ) {}

  send(payload: RelayPayload, bodyText: string): Promise<RelaySendResult> {
    const start = this.queue
      .catch(() => {})
      .then(() => this.startQueued(payload, bodyText))
    const result = start.then(async ({ response, getPayload }) => ({
      response: await response,
      payload: getPayload(),
      transport: 'websocket' as const,
      protocol: 2 as const,
      usedRelay: true,
    }))
    this.queue = start.then(
      ({ done }) => done.catch(() => {}),
      () => {},
    )
    return result
  }

  private async startQueued(payload: RelayPayload, bodyText: string) {
    await this.ensureConnected()
    const localState = sessionState.get(this.affinity)
    const serverHash = this.serverState?.hash
    const requestPayload: RelayPayload = {
      ...payload,
      protocol: 2,
      id: createRequestId(),
    }

    if (
      requestPayload.mode === 'patch' &&
      (!serverHash || serverHash !== requestPayload.base_hash)
    ) {
      requestPayload.mode = 'full_sync'
      requestPayload.revision = (this.serverState?.revision ?? 0) + 1
      delete requestPayload.base_hash
      delete requestPayload.patch
      requestPayload.body = bodyText
    }
    if (requestPayload.mode === 'patch' && localState) {
      requestPayload.patch = createRelayPatch(localState.body, bodyText)
    }

    let activePayload = requestPayload
    const first = this.sendPayload(requestPayload, bodyText)
    void first.done.catch(() => {})
    let activeDone = first.done
    const response = first.response.catch((error) => {
      if (
        !(error instanceof RelayStateMismatchError) ||
        requestPayload.mode !== 'patch'
      ) {
        throw error
      }
      const fullSync = createFullSyncPayload(requestPayload, bodyText)
      fullSync.protocol = 2
      fullSync.id = createRequestId()
      fullSync.revision = (this.serverState?.revision ?? 0) + 1
      activePayload = fullSync
      const retry = this.sendPayload(fullSync, bodyText)
      void retry.done.catch(() => {})
      activeDone = retry.done
      return retry.response
    })
    const done = response.then(
      () => activeDone,
      () => activeDone.catch(() => {}),
    )
    return { response, done, getPayload: () => activePayload }
  }

  private async ensureConnected() {
    if (
      this.socket?.readyState === WebSocket.OPEN &&
      this.serverState !== undefined
    )
      return
    if (this.connecting) return await this.connecting

    this.connecting = new Promise<void>((resolve, reject) => {
      const url = toWebSocketUrl(this.config.url, this.config.token)
      const parsed = new URL(url)
      parsed.searchParams.set('affinity', this.affinity)
      const socket = new WebSocket(parsed.toString())
      this.socket = socket
      this.serverState = undefined

      const timeout = setTimeout(() => {
        socket.close()
        reject(new Error('relay websocket ready timed out'))
      }, 15_000)

      socket.addEventListener('message', (event) => {
        try {
          if (typeof event.data !== 'string') {
            throw new Error('unexpected binary relay control frame')
          }
          const message = parseRelayControlMessage(event.data)
          if (message.type === 'ready') {
            clearTimeout(timeout)
            this.serverState = message.state
            resolve()
            return
          }
          this.handleMessage(message)
        } catch (error) {
          clearTimeout(timeout)
          reject(error)
          this.failPending(error)
          socket.close()
        }
      })

      socket.addEventListener('error', () => {
        clearTimeout(timeout)
        const error = new Error('relay websocket error')
        reject(error)
        this.failPending(error)
      })

      socket.addEventListener('close', () => {
        clearTimeout(timeout)
        if (this.socket === socket) {
          this.socket = undefined
          this.serverState = undefined
          this.connecting = undefined
        }
        if (this.pending) {
          const error = new Error('relay websocket closed before response')
          this.failPending(error)
        }
      })
    }).finally(() => {
      this.connecting = undefined
    })

    await this.connecting
  }

  private sendPayload(payload: RelayPayload, bodyText: string) {
    const socket = this.socket
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('relay websocket is not connected')
    }

    let resolveDone!: () => void
    let rejectDone!: (error: unknown) => void
    const done = new Promise<void>((resolve, reject) => {
      resolveDone = resolve
      rejectDone = reject
    })
    const response = new Promise<Response>((resolve, reject) => {
      const pending: PendingWebSocketRequest = {
        payload,
        bodyText,
        resolve,
        reject,
        streamDone: false,
        accepted: false,
        responseStarted: false,
        resolveDone,
        rejectDone,
      }
      this.pending = pending
      this.resetPendingTimeout(pending)
      socket.send(JSON.stringify(payload))
    })
    return { response, done }
  }

  private resetPendingTimeout(pending: PendingWebSocketRequest) {
    clearTimeout(pending.timeout)
    pending.timeout = setTimeout(() => {
      if (this.pending !== pending) return
      this.failPending(new Error('relay websocket response timed out'))
      this.socket?.close()
    }, 45_000)
  }

  private handleMessage(message: RelayControlMessage) {
    if (message.type === 'keepalive') {
      if (this.pending) this.resetPendingTimeout(this.pending)
      return
    }
    const pending = this.pending
    if (!pending) return
    if ('id' in message && message.id && message.id !== pending.payload.id)
      return

    if (message.type === 'accepted') {
      pending.accepted = true
      this.serverState = { hash: message.hash, revision: message.revision }
      updateLocalRelayState(
        this.affinity,
        pending.bodyText,
        message.hash,
        message.revision,
      )
      this.resetPendingTimeout(pending)
      return
    }
    if (message.type === 'response_start') {
      pending.responseStarted = true
      clearTimeout(pending.timeout)
      const stream = new ReadableStream<Uint8Array>({
        start: (controller) => {
          pending.streamController = controller
        },
        cancel: () => {
          this.socket?.close()
        },
      })
      pending.resolve(
        new Response(stream, {
          status: message.status,
          statusText: message.statusText,
          headers: message.headers,
        }),
      )
      return
    }
    if (message.type === 'chunk') {
      pending.streamController?.enqueue(decodeRelayChunk(message.base64))
      return
    }
    if (message.type === 'done') {
      this.finishPending()
      return
    }
    if (message.type === 'error') {
      const error =
        message.status === 409
          ? new RelayStateMismatchError(message.message || 'state mismatch')
          : new Error(message.message || 'relay websocket error')
      this.failPending(error)
    }
  }

  private finishPending() {
    const pending = this.pending
    if (!pending) return
    clearTimeout(pending.timeout)
    if (!pending.streamDone) {
      pending.streamDone = true
      pending.streamController?.close()
    }
    pending.resolveDone()
    this.pending = undefined
  }

  private failPending(error: unknown) {
    const pending = this.pending
    if (!pending) return
    clearTimeout(pending.timeout)
    this.pending = undefined
    if (pending.responseStarted) {
      pending.streamController?.error(error)
    } else {
      pending.reject(error)
    }
    pending.rejectDone(error)
  }
}

function getPersistentRelaySession(config: RelayConfig, affinity: string) {
  const existing = websocketSessions.get(affinity)
  if (existing) return existing
  const session = new PersistentRelaySession(config, affinity)
  websocketSessions.set(affinity, session)
  return session
}

export async function sendViaRelay(options: {
  config: RelayConfig | null
  input: string | URL | Request
  init: RequestInit | undefined
  headers: Headers
  body: RequestInit['body'] | null | undefined
  fallback: () => Promise<Response>
}): Promise<Response> {
  const { config, input, init, headers, body, fallback } = options
  if (!config || !isRelayableAnthropicRequest(input, body)) return fallback()

  const affinity =
    headers.get('x-session-affinity') || headers.get('x-opencode-session')
  if (!affinity) {
    relayLog('skipping relay: missing x-session-affinity header')
    return fallback()
  }

  const bodyText = body as string
  const nextHash = hashBody(bodyText)
  const previous = sessionState.get(affinity)
  const payload = createRelayPayload({
    input,
    init,
    headers,
    bodyText,
    affinity,
    previous,
    nextHash,
  })
  try {
    let result: RelaySendResult
    if (config.transport === 'websocket') {
      try {
        const session = getPersistentRelaySession(config, affinity)
        result = await session.send(payload, bodyText)
      } catch (error) {
        relayLog(
          `websocket relay failed session=${shortAffinity(affinity)}; trying http relay: ${error instanceof Error ? error.message : String(error)}`,
        )
        result = await sendRelayHttp({ config, payload, bodyText, fallback })
      }
    } else {
      result = await sendRelayHttp({ config, payload, bodyText, fallback })
    }

    if (!result.usedRelay) return result.response

    if (result.transport === 'http') {
      updateLocalRelayState(
        affinity,
        bodyText,
        result.payload.next_hash,
        result.payload.revision,
      )
    }

    const actualPayloadBytes = JSON.stringify(result.payload).length
    relayLog(
      `used relay transport=${result.transport} protocol=${result.protocol} mode=${result.payload.mode} status=${result.response.status} session=${shortAffinity(affinity)} bodyBytes=${bodyText.length} relayBytes=${actualPayloadBytes}`,
    )
    await dumpRelayRequest({
      affinity,
      transport: result.transport,
      protocol: result.protocol,
      mode: result.payload.mode,
      status: result.response.status,
      bodyText,
      previousBodyText: previous?.body,
      payload: result.payload,
      relayBytes: actualPayloadBytes,
    })
    return result.response
  } catch (error) {
    if (!config.fallbackToDirect) {
      relayLog(
        `relay failed session=${shortAffinity(affinity)} and fallbackToDirect=false: ${error instanceof Error ? error.message : String(error)}`,
      )
      throw error
    }
    relayLog(
      `relay failed; falling back direct session=${shortAffinity(affinity)}: ${error instanceof Error ? error.message : String(error)}`,
    )
    return fallback()
  }
}

export const WORKER_SCRIPT = `
async function hashBody(body) {
  const bytes = new TextEncoder().encode(body)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return 'sha256:' + hex
}

function applyPatch(base, patch) {
  return base.slice(0, patch.start) + patch.insert + base.slice(patch.start + patch.deleteCount)
}

function applyPatchSet(base, patch) {
  if (Array.isArray(patch)) return patch.reduce((body, item) => applyPatch(body, item), base)
  return applyPatch(base, patch)
}

async function readState(env, affinity) {
  const raw = await env.RELAY_STATE.get('session:' + affinity)
  return raw ? JSON.parse(raw) : null
}

async function writeState(env, affinity, state) {
  await env.RELAY_STATE.put('session:' + affinity, JSON.stringify(state), { expirationTtl: 86400 })
}

async function resolveBody(env, payload) {
  if (payload.mode === 'full_sync') return payload.body
  if (payload.mode === 'patch') {
    const state = await readState(env, payload.affinity)
    if (!state || state.hash !== payload.base_hash) {
      return { error: 'state mismatch', status: 409 }
    }
    return applyPatchSet(state.body, payload.patch)
  }
  return { error: 'unknown mode', status: 400 }
}

async function prepareUpstream(env, payload) {
  if ((payload.protocol !== 1 && payload.protocol !== 2) || payload.type !== 'request' || !payload.affinity || !payload.upstream?.url || !payload.next_hash) {
    return { error: 'invalid payload', status: 400 }
  }

  const body = await resolveBody(env, payload)
  if (body && typeof body === 'object' && 'error' in body) return body

  if (typeof body !== 'string' || (await hashBody(body)) !== payload.next_hash) {
    return { error: 'hash mismatch', status: 409 }
  }

  await writeState(env, payload.affinity, { body, hash: payload.next_hash, revision: payload.revision })
  console.log(JSON.stringify({
    relay: 'opencode-anthropic-auth',
    transport: 'relay',
    mode: payload.mode,
    revision: payload.revision,
    affinity: String(payload.affinity).slice(0, 12),
    bodyBytes: body.length,
  }))

  return { body }
}

function resolveBodyFromState(state, payload) {
  if (payload.mode === 'full_sync') return payload.body
  if (payload.mode === 'patch') {
    if (!state || state.hash !== payload.base_hash) {
      return { error: 'state mismatch', status: 409 }
    }
    return applyPatchSet(state.body, payload.patch)
  }
  return { error: 'unknown mode', status: 400 }
}

async function prepareWebSocketUpstream(env, state, payload) {
  if (payload.protocol !== 2 || payload.type !== 'request' || !payload.id || !payload.affinity || !payload.upstream?.url || !payload.next_hash) {
    return { error: 'invalid payload', status: 400 }
  }

  const body = resolveBodyFromState(state, payload)
  if (body && typeof body === 'object' && 'error' in body) return body

  if (typeof body !== 'string' || (await hashBody(body)) !== payload.next_hash) {
    return { error: 'hash mismatch', status: 409 }
  }

  const nextState = { body, hash: payload.next_hash, revision: payload.revision }
  try {
    await writeState(env, payload.affinity, nextState)
  } catch (error) {
    console.log(JSON.stringify({
      relay: 'opencode-anthropic-auth',
      transport: 'websocket',
      event: 'checkpoint_write_failed',
      affinity: String(payload.affinity).slice(0, 12),
      message: error instanceof Error ? error.message : String(error),
    }))
  }
  console.log(JSON.stringify({
    relay: 'opencode-anthropic-auth',
    transport: 'websocket',
    mode: payload.mode,
    revision: payload.revision,
    affinity: String(payload.affinity).slice(0, 12),
    bodyBytes: body.length,
  }))

  return { body, state: nextState }
}

function headersToObject(headers) {
  const result = {}
  for (const [key, value] of headers.entries()) result[key] = value
  return result
}

function bytesToBase64(bytes) {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize)
    binary += String.fromCharCode.apply(null, chunk)
  }
  return btoa(binary)
}

async function handleRelayPayload(env, payload) {
  const prepared = await prepareUpstream(env, payload)
  if (prepared.error) return prepared
  const upstream = await fetch(payload.upstream.url, {
    method: payload.upstream.method || 'POST',
    headers: payload.upstream.headers,
    body: prepared.body,
  })
  return { upstream }
}

async function handleWebSocket(socket, env, payload, getState, setState) {
  const heartbeat = setInterval(() => {
    try {
      socket.send(JSON.stringify({ protocol: 2, type: 'keepalive' }))
    } catch {
      clearInterval(heartbeat)
    }
  }, 5000)
  try {
    const result = await prepareWebSocketUpstream(env, getState(), payload)
    if (result.error) {
      socket.send(JSON.stringify({ protocol: 2, type: 'error', id: payload.id, status: result.status, message: result.error }))
      return
    }

    setState(result.state)
    socket.send(JSON.stringify({ protocol: 2, type: 'accepted', id: payload.id, hash: result.state.hash, revision: result.state.revision }))

    const upstream = await fetch(payload.upstream.url, {
      method: payload.upstream.method || 'POST',
      headers: payload.upstream.headers,
      body: result.body,
    })
    socket.send(JSON.stringify({
      protocol: 2,
      type: 'response_start',
      id: payload.id,
      status: upstream.status,
      statusText: upstream.statusText,
      headers: headersToObject(upstream.headers),
    }))

    const reader = upstream.body?.getReader()
    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        socket.send(JSON.stringify({ protocol: 2, type: 'chunk', id: payload.id, base64: bytesToBase64(value) }))
      }
    }
    socket.send(JSON.stringify({ protocol: 2, type: 'done', id: payload.id }))
  } catch (error) {
    socket.send(JSON.stringify({ protocol: 2, type: 'error', id: payload.id, status: 500, message: error instanceof Error ? error.message : String(error) }))
  } finally {
    clearInterval(heartbeat)
  }
}

export default {
  async fetch(request, env) {
    if (request.headers.get('Upgrade') === 'websocket') {
      const url = new URL(request.url)
      const token = url.searchParams.get('token')
      const affinity = url.searchParams.get('affinity')
      if (token !== env.RELAY_TOKEN) return new Response('unauthorized', { status: 401 })
      if (!affinity) return new Response('missing affinity', { status: 400 })
      const pair = new WebSocketPair()
      const client = pair[0]
      const server = pair[1]
      let state = await readState(env, affinity)
      server.accept()
      server.send(JSON.stringify({
        protocol: 2,
        type: 'ready',
        state: state ? { hash: state.hash, revision: state.revision } : null,
      }))
      let busy = false
      server.addEventListener('message', (event) => {
        if (busy) {
          server.send(JSON.stringify({ protocol: 2, type: 'error', status: 429, message: 'request already in flight' }))
          return
        }
        let payload
        try {
          payload = JSON.parse(event.data)
        } catch {
          server.send(JSON.stringify({ protocol: 2, type: 'error', status: 400, message: 'invalid JSON payload' }))
          return
        }
        payload.affinity = affinity
        busy = true
        const run = handleWebSocket(server, env, payload, () => state, (nextState) => { state = nextState }).finally(() => { busy = false })
        event.waitUntil?.(run)
        if (!event.waitUntil) void run
      })
      return new Response(null, { status: 101, webSocket: client })
    }

    if (request.method === 'GET') return new Response('ok')
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
    if (request.headers.get('x-relay-token') !== env.RELAY_TOKEN) {
      return new Response('unauthorized', { status: 401 })
    }

    const payload = await request.json()
    const result = await handleRelayPayload(env, payload)
    if (result.error) return Response.json({ error: result.error }, { status: result.status })

    const upstream = result.upstream
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    })
  },
}
`
