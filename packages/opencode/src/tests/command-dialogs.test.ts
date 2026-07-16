import { describe, expect, test } from 'bun:test'
import type { PrimeAccountStatus } from '@cortexkit/anthropic-auth-core'
import {
  buildKillswitchThresholdSeed,
  buildPrimeStatusRows,
} from '../tui/command-dialogs'

describe('buildKillswitchThresholdSeed', () => {
  test('preserves scoped killswitch thresholds in the TUI edit seed', () => {
    expect(
      buildKillswitchThresholdSeed(
        {
          main: { five_hour: 5, seven_day: 10, scoped: 20 },
          accounts: {
            umut: { five_hour: 3, seven_day: 8, scoped: 0 },
          },
        },
        ['umut'],
      ),
    ).toBe('main:5,10,20 umut:3,8,0')
  })

  test('falls back to main thresholds and scoped default for accounts without overrides', () => {
    expect(
      buildKillswitchThresholdSeed({ main: { five_hour: 5, seven_day: 10 } }, [
        'umut',
      ]),
    ).toBe('main:5,10,0 umut:5,10,0')
  })
})

describe('buildPrimeStatusRows', () => {
  const base = {
    id: 'main',
    label: 'main',
    nextDueAt: null,
  } as PrimeAccountStatus

  test('renders future-due, successful prime, and active-window rows', () => {
    const futureDue = Date.now() + 60 * 60_000
    const past = Date.now() - 60_000
    const rows = buildPrimeStatusRows([
      { ...base, id: 'main', nextDueAt: futureDue },
      {
        id: 'work-alt',
        label: 'work-alt',
        nextDueAt: null,
        lastPrimedAt: past,
        lastResult: 'ok',
        usage: { count: 12, inputTokens: 240, outputTokens: 12, since: 1 },
        estimatedCostUsd: 0.00132,
      },
      {
        id: 'expired',
        label: 'expired',
        // active window: a past nextDueAt means the reset has happened but
        // the window already started; no row says "primed" and no future
        // prime is due.
        nextDueAt: past,
      },
    ])
    expect(rows.length).toBeGreaterThanOrEqual(4)
    expect(rows[0]).toContain('main · next prime')
    expect(rows.find((r) => r.includes('work-alt · primed'))).toBeDefined()
    expect(rows.find((r) => r.includes('12 primes'))).toBeDefined()
    expect(rows.find((r) => r.includes('— window active'))).toBeDefined()
  })

  test('error row uses "primed HH:MM err" notation', () => {
    const rows = buildPrimeStatusRows([
      {
        id: 'work-alt',
        label: 'work-alt',
        nextDueAt: null,
        lastPrimedAt: Date.now() - 60_000,
        lastResult: 'error',
      },
    ])
    expect(rows[0]).toContain('primed')
    expect(rows[0]).toContain('err')
  })
})
