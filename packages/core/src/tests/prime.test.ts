import { describe, expect, test } from 'bun:test'
import type { AccountStorage } from '../accounts.ts'
import {
  buildPrimeAccountStatuses,
  buildPrimeStatusSummary,
  CLAUDE_HAIKU_4_5_PRICING,
  estimatePrimeCostUsd,
  executePrimeCommand,
  type PrimeAccountStatus,
  parsePrimeCommandAction,
} from '../prime.ts'

const STORAGE_TS = 1_721_111_111_000
const DUE_TS = STORAGE_TS - 60_000
const ISO_DUE = new Date(DUE_TS).toISOString()

function storage(): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    accounts: [
      {
        id: 'work-alt',
        type: 'oauth',
        refresh: 'r',
        enabled: true,
        quota: {
          five_hour: {
            usedPercent: 0,
            remainingPercent: 100,
            resetsAt: ISO_DUE,
            checkedAt: STORAGE_TS,
          },
        },
        prime: {
          count: 1,
          inputTokens: 20,
          outputTokens: 1,
          since: 1_721_111_112_000,
        },
      },
    ],
  }
}

describe('parsePrimeCommandAction', () => {
  test('empty → status', () => {
    expect(parsePrimeCommandAction('')).toEqual({ type: 'status' })
  })
  test('on → enable', () => {
    expect(parsePrimeCommandAction('on')).toEqual({ type: 'enable' })
  })
  test('off → disable', () => {
    expect(parsePrimeCommandAction('off')).toEqual({ type: 'disable' })
  })
  test('anything else → usage', () => {
    expect(parsePrimeCommandAction('hello')).toEqual({ type: 'usage' })
    expect(parsePrimeCommandAction('on extra')).toEqual({ type: 'usage' })
  })
})

describe('estimatePrimeCostUsd', () => {
  test('zero usage is zero', () => {
    expect(
      estimatePrimeCostUsd({
        count: 0,
        inputTokens: 0,
        outputTokens: 0,
        since: 0,
      }),
    ).toBe(0)
  })
  test('20 input + 1 output tokens = $0.000025 (per-million pricing)', () => {
    expect(
      estimatePrimeCostUsd({
        count: 1,
        inputTokens: 20,
        outputTokens: 1,
        since: 1,
      }),
    ).toBeCloseTo(
      (20 * CLAUDE_HAIKU_4_5_PRICING.input +
        1 * CLAUDE_HAIKU_4_5_PRICING.output) /
        1_000_000,
      9,
    )
  })
  test('undefined usage → 0', () => {
    expect(estimatePrimeCostUsd(undefined)).toBe(0)
  })
})

describe('buildPrimeAccountStatuses', () => {
  test('synthetic main + enabled fallback; nextDueAt derived from resetsAt', () => {
    const statuses = buildPrimeAccountStatuses(storage(), { now: STORAGE_TS })
    expect(statuses).toHaveLength(2)
    const main = statuses.find((s) => s.id === 'main')
    expect(main?.label).toBe('main')
    expect(main?.usage).toBeUndefined()
    expect(main?.estimatedCostUsd).toBe(0)
    const fallback = statuses.find((s) => s.id === 'work-alt')
    expect(fallback?.label).toBe('work-alt')
    expect(fallback?.nextDueAt).toBe(DUE_TS + 60_000)
    expect(fallback?.usage?.count).toBe(1)
    expect(fallback?.estimatedCostUsd).toBeCloseTo(
      (20 * CLAUDE_HAIKU_4_5_PRICING.input +
        1 * CLAUDE_HAIKU_4_5_PRICING.output) /
        1_000_000,
      9,
    )
  })

  test('omits disabled and api-key fallbacks', () => {
    const s = storage()
    s.accounts.push({ id: 'apikey-1', type: 'api', baseURL: 'https://x.y' })
    s.accounts.push({
      id: 'disabled-fb',
      type: 'oauth',
      refresh: 'r',
      enabled: false,
    })
    const statuses = buildPrimeAccountStatuses(s, { now: STORAGE_TS })
    expect(statuses.map((x) => x.id)).toEqual(['main', 'work-alt'])
  })

  test('manager transient overlay overrides runtime state', () => {
    const transient = new Map<
      string,
      { lastPrimedAt?: number; lastResult?: 'ok' | 'error' }
    >()
    transient.set('work-alt', { lastPrimedAt: 999, lastResult: 'error' })
    const statuses = buildPrimeAccountStatuses(storage(), {
      now: STORAGE_TS,
      transient,
    })
    const fb = statuses.find((s) => s.id === 'work-alt') as PrimeAccountStatus
    expect(fb.lastPrimedAt).toBe(999)
    expect(fb.lastResult).toBe('error')
  })

  test('null nextDueAt when no resetsAt', () => {
    const s = storage()
    s.accounts = []
    const statuses = buildPrimeAccountStatuses(s, { now: STORAGE_TS })
    const main = statuses.find((s) => s.id === 'main') as PrimeAccountStatus
    expect(main.nextDueAt).toBeNull()
  })
})

describe('buildPrimeStatusSummary', () => {
  test('shows status, accounts, counts, cost', () => {
    const accounts: PrimeAccountStatus[] = [
      {
        id: 'main',
        label: 'main',
        nextDueAt: null,
        usage: {
          count: 12,
          inputTokens: 240,
          outputTokens: 12,
          since: 1,
        },
        estimatedCostUsd:
          (240 * CLAUDE_HAIKU_4_5_PRICING.input +
            12 * CLAUDE_HAIKU_4_5_PRICING.output) /
          1_000_000,
      },
      {
        id: 'work-alt',
        label: 'work-alt',
        nextDueAt: DUE_TS + 60_000,
        usage: { count: 0, inputTokens: 0, outputTokens: 0, since: 1 },
        estimatedCostUsd: 0,
      },
    ]
    const summary = buildPrimeStatusSummary({ enabled: true, accounts })
    expect(summary).toContain('## Claude Prime Status')
    expect(summary).toContain('main · ')
    expect(summary).toContain('work-alt · next prime')
    expect(summary).toContain('12 primes')
    expect(summary).toContain('\u2248 $')
  })
})

describe('executePrimeCommand', () => {
  const accounts: PrimeAccountStatus[] = [
    {
      id: 'main',
      label: 'main',
      nextDueAt: null,
      usage: { count: 0, inputTokens: 0, outputTokens: 0, since: 1 },
      estimatedCostUsd: 0,
    },
  ]

  test('status returns title without updated', () => {
    const r = executePrimeCommand({
      argumentsText: '',
      enabled: true,
      accounts,
    })
    expect(r.updated).toBeUndefined()
    expect(r.text).toContain('## Claude Prime Status')
  })

  test('on returns updated { enabled: true }', () => {
    const r = executePrimeCommand({
      argumentsText: 'on',
      enabled: true,
      accounts,
    })
    expect(r.updated).toEqual({ enabled: true })
  })

  test('off returns updated { enabled: false }', () => {
    const r = executePrimeCommand({
      argumentsText: 'off',
      enabled: true,
      accounts,
    })
    expect(r.updated).toEqual({ enabled: false })
  })

  test('unknown args returns usage text', () => {
    const r = executePrimeCommand({
      argumentsText: 'maybe',
      enabled: false,
      accounts,
    })
    expect(r.updated).toBeUndefined()
    expect(r.text).toContain('Usage')
  })

  test('does not persist or mutate anything', () => {
    const r = executePrimeCommand({
      argumentsText: 'on',
      enabled: false,
      accounts,
    })
    expect(typeof r.text).toBe('string')
    expect(r.updated).toEqual({ enabled: true })
  })
})
