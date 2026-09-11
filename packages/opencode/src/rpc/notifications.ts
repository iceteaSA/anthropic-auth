import { logger } from '@cortexkit/anthropic-auth-core'

import type { OpenDialogPayload, RpcNotification } from './protocol'

const QUEUE_CAP = 100
const TUI_CONNECTED_WINDOW_MS = 3_000

// One queue serves every RPC server in the process, and a process can hold one server per
// project directory. Session ids are globally unique, so a notice that carries one reaches
// only the TUI polling for that session. A notice WITHOUT one broadcasts instead: every
// draining TUI receives it and one session's ack does not prune it for the others — which,
// once a process serves more than one project, would carry it across project boundaries.
// The producer boundary therefore requires a session id; the wire field stays optional so
// an older TUI still parses what it is sent.
let queue: RpcNotification[] = []
let nextId = 1
const lastDrainAtBySession = new Map<string, number>()
let warnedAboutUnscopedDrain = false

export function pushNotification(
  payload: OpenDialogPayload,
  sessionId: string,
): void {
  queue.push({ id: nextId++, type: 'open-dialog', payload, sessionId })
  if (queue.length > QUEUE_CAP) queue = queue.slice(queue.length - QUEUE_CAP)
}

export function drainNotifications(
  lastReceivedId = 0,
  sessionId?: string,
): RpcNotification[] {
  const now = Date.now()
  if (sessionId !== undefined) lastDrainAtBySession.set(sessionId, now)
  const matches = (n: RpcNotification) =>
    sessionId === undefined || n.sessionId === sessionId
  if (sessionId === undefined && !warnedAboutUnscopedDrain) {
    warnedAboutUnscopedDrain = true
    logger.warn(
      'rpc.notifications',
      'drain arrived without a session id; delivery is unscoped and the queue is left intact',
    )
  }
  if (lastReceivedId > 0) {
    queue = queue.filter((n) => {
      if (n.id > lastReceivedId) return true
      if (sessionId === undefined) return true
      return n.sessionId !== sessionId
    })
  }
  return queue.filter((n) => n.id > lastReceivedId && matches(n))
}

export function isTuiConnected(sessionId: string): boolean {
  const now = Date.now()
  const at = lastDrainAtBySession.get(sessionId) ?? 0
  return at > 0 && now - at < TUI_CONNECTED_WINDOW_MS
}

export function resetNotificationsForTest(): void {
  queue = []
  nextId = 1
  lastDrainAtBySession.clear()
  warnedAboutUnscopedDrain = false
}
