import { beforeEach, describe, expect, test } from 'bun:test'
import {
  __setLogTestSink,
  type LogTestRecord,
} from '@cortexkit/anthropic-auth-core'
import {
  drainNotifications,
  isTuiConnected,
  pushNotification,
  resetNotificationsForTest,
} from '../rpc/notifications'
import type { OpenDialogPayload } from '../rpc/protocol'

const payload = (command: OpenDialogPayload['command']): OpenDialogPayload => ({
  command,
  text: 'x',
  knobs: {},
})

describe('notifications', () => {
  beforeEach(() => resetNotificationsForTest())

  test('warns once when an unscoped drain leaves the queue intact', () => {
    const records: LogTestRecord[] = []
    __setLogTestSink((record) => records.push(record))
    try {
      drainNotifications(0)
      drainNotifications(0)
      expect(
        records.filter(
          (record) =>
            record.level === 'warn' &&
            record.message.includes('drain arrived without a session id'),
        ),
      ).toHaveLength(1)
    } finally {
      __setLogTestSink(null)
    }
  })

  test('an unscoped drain delivers every pending notice', () => {
    pushNotification(payload('claude-quota'), 's1')
    pushNotification(payload('claude-dump'), 's2')

    expect(
      drainNotifications(0, undefined).map((n) => n.payload.command),
    ).toEqual(['claude-quota', 'claude-dump'])
  })

  test('an unscoped drain acknowledges without pruning other sessions', () => {
    pushNotification(payload('claude-quota'), 's1')
    pushNotification(payload('claude-dump'), 's2')

    // Acknowledged notices are not re-delivered to the client that acked them,
    // and an unscoped ack must not speak for the sessions it does not name.
    expect(drainNotifications(2, undefined)).toEqual([])
    expect(drainNotifications(0, 's2').map((n) => n.payload.command)).toEqual([
      'claude-dump',
    ])
    expect(drainNotifications(0, 's1').map((n) => n.payload.command)).toEqual([
      'claude-quota',
    ])
  })

  test('reset re-arms the unscoped-drain warning after an earlier drain', () => {
    const records: LogTestRecord[] = []
    __setLogTestSink((record) => records.push(record))
    try {
      drainNotifications(0)
      resetNotificationsForTest()
      drainNotifications(0)
      expect(
        records.filter(
          (record) =>
            record.level === 'warn' &&
            record.message.includes('drain arrived without a session id'),
        ),
      ).toHaveLength(2)
    } finally {
      __setLogTestSink(null)
    }
  })

  test('a session-scoped drain prunes its own acknowledged notices', () => {
    pushNotification(payload('claude-quota'), 's1')
    pushNotification(payload('claude-dump'), 's2')

    const s1 = drainNotifications(0, 's1')
    expect(drainNotifications(s1[0]?.id, 's1')).toEqual([])
    expect(drainNotifications(0, 's2').map((n) => n.payload.command)).toEqual([
      'claude-dump',
    ])
  })

  test('push then drain returns the item once, ordered', () => {
    pushNotification(payload('claude-quota'), 's1')
    pushNotification(payload('claude-fast'), 's1')
    const first = drainNotifications(0, 's1')
    expect(first.map((n) => n.payload.command)).toEqual([
      'claude-quota',
      'claude-fast',
    ])
    expect(first[0]?.id).toBeLessThan(first[1]?.id as number)
    const second = drainNotifications(first[1]?.id as number, 's1')
    expect(second).toEqual([])
  })

  test('every queued notice carries its session id and stays scoped to it', () => {
    pushNotification(payload('claude-quota'), 's1')
    pushNotification(payload('claude-dump'), 's2')
    const s1 = drainNotifications(0, 's1')

    expect(s1).toHaveLength(1)
    expect(s1[0]?.sessionId).toBe('s1')
    expect(s1.map((n) => n.payload.command)).toEqual(['claude-quota'])
    expect(drainNotifications(0, 's2').map((n) => n.payload.command)).toEqual([
      'claude-dump',
    ])
  })

  test('isTuiConnected reflects a recent drain within the window', () => {
    expect(isTuiConnected('s1')).toBe(false)
    drainNotifications(0, 's1')
    expect(isTuiConnected('s1')).toBe(true)
  })

  test('a drain only marks its own session as connected', () => {
    drainNotifications(0, 's2')
    expect(isTuiConnected('s1')).toBe(false)
    expect(isTuiConnected('s2')).toBe(true)
    // @ts-expect-error isTuiConnected requires a session id
    expect(isTuiConnected()).toBe(false)
  })

  test('queue cap evicts oldest beyond 100', () => {
    for (let i = 0; i < 130; i++)
      pushNotification(payload('claude-quota'), 's1')
    const all = drainNotifications(0, 's1')
    expect(all.length).toBe(100)
  })

  test('pushNotification requires a session id at compile time', () => {
    // @ts-expect-error pushNotification requires a session id
    pushNotification(payload('claude-quota'))
  })
})
