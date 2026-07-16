import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  __setLogTestSink,
  type AccountStorage,
  type LogTestRecord,
  type OAuthAccount,
  type OAuthQuotaSnapshot,
  setLogLevel,
} from '@cortexkit/anthropic-auth-core'
// Source-side logger import — installed as a second sink so PrimeManager logs
// (which are emitted through the in-package logger instance loaded via the
// relative `./logger.ts` path) reach the test capture array. The dist logger
// instance is the package-alias target used by other tests; both must be
// wired to keep sink assertions consistent across runs.
import {
  __setLogTestSink as __setLogTestSinkSource,
  getLogLevel,
  setLogLevel as setLogLevelSource,
} from '../logger.ts'
import type { PrimeRefreshResult } from '../prime.ts'
import {
  buildPrimeAccountStatuses,
  buildPrimeStatusSummary,
  CLAUDE_HAIKU_4_5_PRICING,
  estimatePrimeCostUsd,
  executePrimeCommand,
  type PrimeAccountStatus,
  PrimeManager,
  type PrimeSendResult,
  type PrimeUsageCounters,
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

  test('undefined nextDueAt when no resetsAt', () => {
    const s = storage()
    s.accounts = []
    const statuses = buildPrimeAccountStatuses(s, { now: STORAGE_TS })
    const main = statuses.find((s) => s.id === 'main') as PrimeAccountStatus
    expect(main.nextDueAt).toBeUndefined()
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

// -- PrimeManager ----------------------------------------------------------

interface SendCall {
  accountId: 'main' | string
  result: PrimeSendResult
}

function makePrimeFixture(opts?: {
  enabled?: boolean
  mainQuota?: OAuthQuotaSnapshot
  fallbackQuota?: OAuthQuotaSnapshot
  fallbackEnabled?: boolean
  fallbackType?: 'oauth' | 'api'
  fallbackPermanent?: boolean
  killswitch?: { enabled?: boolean }
}) {
  const accountId = 'work-alt'
  const accounts: AccountStorage['accounts'] = []
  if (opts?.fallbackType !== undefined) {
    if (opts.fallbackType === 'api') {
      accounts.push({
        id: accountId,
        type: 'api',
        baseURL: 'https://example.com',
      })
    } else {
      accounts.push({
        id: accountId,
        type: 'oauth',
        refresh: 'r',
        enabled: opts.fallbackEnabled !== false,
        ...(opts.fallbackPermanent && {
          lastRefreshError: {
            message: 'invalid_grant',
            checkedAt: 1,
            status: 400,
            permanent: true,
          },
        }),
        ...(opts.fallbackQuota && { quota: opts.fallbackQuota }),
      } as OAuthAccount)
    }
  }
  const storage: AccountStorage = {
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    quota: opts?.mainQuota
      ? {
          enabled: true,
          checkIntervalMinutes: 5,
          mainQuota: opts.mainQuota,
          mainQuotaCheckedAt: 1,
          mainQuotaToken: 'fp',
        }
      : undefined,
    killswitch: opts?.killswitch,
    prime: { enabled: true },
    accounts,
  }
  return { storage, accountId }
}

interface Harness {
  manager: PrimeManager
  sendCalls: SendCall[]
  refreshCalls: string[]
  recordSuccessCalls: Array<{
    accountId: 'main' | string
    usage: { inputTokens?: number; outputTokens?: number }
    returnCounters: PrimeUsageCounters
  }>
  records: LogTestRecord[]
  markerDir: string
  cleanup: () => Promise<void>
}

async function makeHarness(opts: {
  storage: AccountStorage
  markerDir: string
  now: number
  quotaFresh: OAuthQuotaSnapshot
  quotaFreshIsStale?: boolean
  send?: (id: 'main' | string) => PrimeSendResult | Promise<PrimeSendResult>
  recordSuccessReturn?: PrimeUsageCounters
  refreshError?: Error
}): Promise<Harness> {
  const sendCalls: SendCall[] = []
  const refreshCalls: string[] = []
  const recordSuccessCalls: Harness['recordSuccessCalls'] = []

  const manager = new PrimeManager({
    loadStorage: async () => opts.storage,
    refreshQuota: async (id) => {
      refreshCalls.push(id)
      if (opts.refreshError) throw opts.refreshError
      const result: PrimeRefreshResult = {
        quota: opts.quotaFresh,
        fresh: opts.quotaFreshIsStale !== true,
      }
      return result
    },
    sendPrime: async (id) => {
      const result = opts.send
        ? await opts.send(id)
        : {
            ok: true,
            status: 200,
            ms: 1,
            usage: { inputTokens: 20, outputTokens: 1 },
          }
      sendCalls.push({ accountId: id, result })
      return result
    },
    recordSuccess: async (accountId, usage) => {
      const counters = opts.recordSuccessReturn ?? {
        count: 1,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        since: opts.now,
      }
      recordSuccessCalls.push({ accountId, usage, returnCounters: counters })
      return counters
    },
    now: () => opts.now,
    markerDir: opts.markerDir,
  })

  return {
    manager,
    sendCalls,
    refreshCalls,
    recordSuccessCalls,
    records: [],
    markerDir: opts.markerDir,
    cleanup: async () => {
      manager.stop()
    },
  }
}

let markerRoot: string
let capturedPrimeSink: LogTestRecord[] = []

beforeEach(async () => {
  markerRoot = await mkdtemp(join(tmpdir(), 'prime-manager-test-'))
  capturedPrimeSink = []
  const sink = (r: LogTestRecord) => {
    capturedPrimeSink.push(r)
  }
  __setLogTestSink(sink)
  __setLogTestSinkSource(sink)
})

afterEach(async () => {
  __setLogTestSink(null)
  __setLogTestSinkSource(null)
  if (markerRoot) {
    await rm(markerRoot, { recursive: true, force: true }).catch(() => {})
  }
})

describe('PrimeManager — due boundary', () => {
  test('resetsAt + 59s is not yet due', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(1_000_000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 1_000_000 + 59_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          ...(fixture.storage.quota?.mainQuota?.five_hour as {
            usedPercent: number
            remainingPercent: number
            resetsAt: string
            checkedAt: number
          }),
        },
      },
    })
    await h.manager.tick()
    expect(h.refreshCalls).toEqual([])
    expect(h.sendCalls).toEqual([])
    await h.cleanup()
  })

  test('resetsAt + 61s is due and fires', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(1_000_000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 1_000_000 + 61_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(1_000_000 - 1).toISOString(),
          checkedAt: 1,
        },
      },
    })
    await h.manager.tick()
    expect(h.refreshCalls).toEqual(['main'])
    expect(h.sendCalls.map((c) => c.accountId)).toEqual(['main'])
    expect(h.recordSuccessCalls).toHaveLength(1)
    await h.cleanup()
  })
})

describe('PrimeManager — fresh-check', () => {
  test('future resetsAt → skip + no claim', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 50,
          remainingPercent: 50,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 50,
          remainingPercent: 50,
          resetsAt: new Date(now + 5 * 60_000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    await h.manager.tick()
    expect(h.sendCalls).toEqual([])
    expect((await readdir(markerRoot)).length).toBe(0)
    await h.cleanup()
  })

  test('absent five_hour fires (inactive-window shape 1)', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: { scoped: [] },
    })
    await h.manager.tick()
    expect(h.sendCalls).toHaveLength(1)
    expect((await readdir(markerRoot)).length).toBe(1)
    await h.cleanup()
  })

  test('past resetsAt fires (inactive-window shape 2)', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    await h.manager.tick()
    expect(h.sendCalls).toHaveLength(1)
    await h.cleanup()
  })
})

describe('PrimeManager — claim atomicity', () => {
  test('two managers, same marker dir + reset epoch → exactly one fires', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const fresh: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: new Date(now - 1000).toISOString(),
        checkedAt: 1,
      },
    }
    const a = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: fresh,
    })
    const b = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: fresh,
    })
    await Promise.all([a.manager.tick(), b.manager.tick()])
    const total = a.sendCalls.length + b.sendCalls.length
    expect(total).toBe(1)
    expect((await readdir(markerRoot)).length).toBe(1)
    await a.cleanup()
    await b.cleanup()
  })
})

describe('PrimeManager — eligibility', () => {
  test('disabled fallback is skipped', async () => {
    const fixture = makePrimeFixture({
      fallbackEnabled: false,
      fallbackQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    await h.manager.tick()
    expect(h.sendCalls).toEqual([])
    await h.cleanup()
  })

  test('api-key fallback is skipped', async () => {
    const fixture = makePrimeFixture({
      fallbackType: 'api',
    })
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now: 1_000_000,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(0).toISOString(),
          checkedAt: 1,
        },
      },
    })
    await h.manager.tick()
    expect(h.sendCalls).toEqual([])
    await h.cleanup()
  })

  test('permanent refresh error → skipped', async () => {
    const fixture = makePrimeFixture({
      fallbackPermanent: true,
      fallbackQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    await h.manager.tick()
    expect(h.sendCalls).toEqual([])
    await h.cleanup()
  })

  test('killswitched account is skipped (no modelId)', async () => {
    const fixture = makePrimeFixture({
      killswitch: { enabled: true, main: { five_hour: 5 } },
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    await h.manager.tick()
    expect(h.sendCalls).toEqual([])
    await h.cleanup()
  })
})

describe('PrimeManager — main + fallbacks evaluated independently', () => {
  test('due fallback fires even when main is not due', async () => {
    const mainFresh = new Date(1_000_000).toISOString()
    const fbFresh = new Date(500).toISOString()
    const fixture = makePrimeFixture({
      fallbackType: 'oauth',
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: mainFresh,
          checkedAt: 1,
        },
      },
      fallbackQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: fbFresh,
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    await h.manager.tick()
    expect(h.sendCalls.map((c) => c.accountId)).toEqual(['work-alt'])
    await h.cleanup()
  })
})

describe('PrimeManager — catch-up', () => {
  test('overdue reset fires on first explicit tick', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 10 * 60_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    await h.manager.tick()
    expect(h.sendCalls.map((c) => c.accountId)).toEqual(['main'])
    expect(h.recordSuccessCalls).toHaveLength(1)
    await h.cleanup()
  })
})

describe('PrimeManager — refresh failure', () => {
  test('refresh failure consumes no marker; next tick can retry', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: { five_hour: undefined },
      refreshError: new Error('boom'),
    })
    await h.manager.tick()
    expect(h.sendCalls).toEqual([])
    expect((await readdir(markerRoot)).length).toBe(0)
    h.refreshCalls.length = 0
    const refreshed: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 0,
        remainingPercent: 100,
        resetsAt: new Date(now - 1000).toISOString(),
        checkedAt: 1,
      },
    }
    h.manager.options.refreshQuota = async () => ({
      quota: refreshed,
      fresh: true,
    })
    await h.manager.tick()
    expect(h.sendCalls).toHaveLength(1)
    await h.cleanup()
  })
})

describe('PrimeManager — send failure', () => {
  test('send failure: marker kept, lastResult=error, no retry this cycle', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
      send: () => ({ ok: false, error: 'boom', status: 500 }),
    })
    await h.manager.tick()
    expect(h.sendCalls).toHaveLength(1)
    expect(h.recordSuccessCalls).toHaveLength(0)
    expect((await readdir(markerRoot)).length).toBe(1)
    const stats = h.manager.stats()
    expect(stats[0]?.lastResult).toBe('error')
    h.sendCalls.length = 0
    await h.manager.tick()
    expect(h.sendCalls).toEqual([])
    await h.cleanup()
  })
})

describe('PrimeManager — recordSuccess', () => {
  test('successful send calls recordSuccess once; stats reflect cumulative counters', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
      recordSuccessReturn: {
        count: 12,
        inputTokens: 240,
        outputTokens: 12,
        since: 1,
      },
    })
    await h.manager.tick()
    expect(h.recordSuccessCalls).toHaveLength(1)
    expect(h.recordSuccessCalls[0]?.accountId).toBe('main')
    const stats = h.manager.stats()
    expect(stats[0]?.usage?.count).toBe(12)
    expect(stats[0]?.lastResult).toBe('ok')
    expect(stats[0]?.estimatedCostUsd).toBeCloseTo(
      (240 * CLAUDE_HAIKU_4_5_PRICING.input +
        12 * CLAUDE_HAIKU_4_5_PRICING.output) /
        1_000_000,
      9,
    )
    await h.cleanup()
  })
})

describe('PrimeManager — marker sweep', () => {
  test('markers older than six hours are removed; fresh markers survive', async () => {
    const oldMarker = join(markerRoot, 'main-100000')
    await writeFile(oldMarker, '', 'utf8')
    const oldTime = new Date(0)
    await utimes(oldMarker, oldTime, oldTime)

    const freshMarker = join(markerRoot, 'main-200000')
    await writeFile(freshMarker, '', 'utf8')

    const fixture = makePrimeFixture({})
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now: 1_000_000_000,
      quotaFresh: {},
    })
    await h.manager.tick()
    const remaining = (await readdir(markerRoot)).sort()
    expect(remaining).toContain('main-200000')
    expect(remaining).not.toContain('main-100000')
    await h.cleanup()
  })
})

describe('PrimeManager — lifecycle', () => {
  test('start is idempotent; stop is idempotent', async () => {
    const fixture = makePrimeFixture({})
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now: 1,
      quotaFresh: {},
    })
    h.manager.start()
    h.manager.start()
    h.manager.start()
    h.manager.stop()
    h.manager.stop()
    await h.cleanup()
  })

  test('a tick already in flight aborts before claim when stop() is called', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    // Block refreshQuota until we call stop() so the manager is mid-tick.
    let releaseRefresh: (() => void) | undefined
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    // Override the refresh adapter to block on the gate.
    h.manager.options.refreshQuota = async () => {
      await refreshBlocked
      return {
        quota: {
          five_hour: {
            usedPercent: 0,
            remainingPercent: 100,
            resetsAt: new Date(now - 1000).toISOString(),
            checkedAt: 1,
          },
        },
        fresh: true,
      }
    }
    const tickPromise = h.manager.tick()
    // Let the tick reach the refresh await.
    await Bun.sleep(10)
    h.manager.stop()
    releaseRefresh!()
    await tickPromise
    // No claim should have been written because the post-refresh stop
    // check aborted the cycle.
    const remaining = await readdir(markerRoot)
    expect(remaining).toEqual([])
    await h.cleanup()
  })
})

describe('PrimeManager — opt-in toggle', () => {
  test('a tick after `prime.enabled=false` does not fire even if due', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    // Disable the feature in stored state.
    fixture.storage.prime = { enabled: false }
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    await h.manager.tick()
    expect(h.sendCalls).toEqual([])
    expect((await readdir(markerRoot)).length).toBe(0)
    await h.cleanup()
  })

  test('a tick that re-reads storage after refresh sees a fresh opt-in toggle', async () => {
    // Fixture is initially enabled, but the loadStorage adapter flips to
    // disabled after the refresh await — simulating an `/claude-prime off`
    // racing with an in-flight tick. The post-refresh opt-in check must
    // abort the cycle before claim.
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    let storageDisabled = false
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    h.manager.options.loadStorage = async () => {
      if (storageDisabled) {
        return { ...fixture.storage, prime: { enabled: false } }
      }
      return fixture.storage
    }
    h.manager.options.refreshQuota = async () => {
      storageDisabled = true
      return {
        quota: {
          five_hour: {
            usedPercent: 0,
            remainingPercent: 100,
            resetsAt: new Date(now - 1000).toISOString(),
            checkedAt: 1,
          },
        },
        fresh: true,
      }
    }
    await h.manager.tick()
    expect(h.sendCalls).toEqual([])
    expect((await readdir(markerRoot)).length).toBe(0)
    await h.cleanup()
  })
})

describe('PrimeManager — fresh-check staleness', () => {
  test('a stale fresh-check (quota API in 429-backoff) skips without claiming', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      // Stored quota has a past resetsAt (so due). The fresh adapter
      // returns a CACHED past resetsAt — i.e. the quota API was in 429
      // backoff and the adapter just returned the cached value with
      // `fresh: false`. Without the staleness guard a stale past resetsAt
      // would let the manager claim+fire against an already-started
      // window.
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
      quotaFreshIsStale: true,
    })
    await h.manager.tick()
    expect(h.sendCalls).toEqual([])
    expect((await readdir(markerRoot)).length).toBe(0)
    // `prime fired` must NOT appear — the skip is a fresh-check skip, not
    // a successful prime.
    const fired = capturedPrimeSink.filter(
      (r) => r.channel === 'prime' && r.message === 'prime fired',
    )
    expect(fired).toHaveLength(0)
    await h.cleanup()
  })
})

describe('PrimeManager — fresh-check skip does not record as primed', () => {
  test('window-active observation does not touch lastPrimedAt/lastResult', async () => {
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      // Fresh quota has a future resetsAt (window already running).
      quotaFresh: {
        five_hour: {
          usedPercent: 50,
          remainingPercent: 50,
          resetsAt: new Date(now + 5 * 60_000).toISOString(),
          checkedAt: 1,
        },
      },
    })
    await h.manager.tick()
    expect(h.sendCalls).toEqual([])
    const stats = h.manager.stats(fixture.storage, now)
    const mainStatus = stats.find((s) => s.id === 'main') as
      | { lastPrimedAt?: number | null; lastResult?: 'ok' | 'error' }
      | undefined
    // lastPrimedAt / lastResult must NOT be set on a fresh-check skip.
    // Otherwise the status would render "primed HH:MM ✓" for a request
    // that never fired.
    expect(mainStatus?.lastPrimedAt == null).toBe(true)
    expect(mainStatus?.lastResult).toBeUndefined()
    // `isWindowActive` exposes the observation separately so the
    // status / sidebar can render "— window active" without conflating
    // it with a successful prime.
    expect(h.manager.isWindowActive('main')).toBe(true)
    await h.cleanup()
  })
})

describe('PrimeManager — logging', () => {
  test('token-refresh failure logs `prime token refresh failed` (warn) — distinct from the generic `prime fire failed`', async () => {
    const previousLevel = getLogLevel()
    setLogLevel('warn')
    setLogLevelSource('warn')
    // Only one eligible account (work-alt) so the assertion is
    // unambiguous: exactly one `prime token refresh failed` record
    // for the single fire path. Main has no stored quota, so its
    // runForAccount short-circuits on the not-due branch.
    const fixture = makePrimeFixture({})
    fixture.storage.accounts.push({
      id: 'work-alt',
      type: 'oauth',
      refresh: 'r',
      quota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
      send: () => ({
        ok: false,
        reason: 'token-refresh',
        error: 'main refresh failed',
      }),
    })
    await h.manager.tick()

    const tokenRefreshWarns = capturedPrimeSink.filter(
      (r) =>
        r.channel === 'prime' &&
        r.level === 'warn' &&
        r.message === 'prime token refresh failed',
    )
    expect(tokenRefreshWarns).toHaveLength(1)
    const payload = tokenRefreshWarns[0]?.payload as
      | { account?: string; error?: string }
      | undefined
    expect(payload?.account).toBe('work-alt')
    expect(payload?.error).toBe('main refresh failed')

    // The generic `prime fire failed` must NOT fire for a token-refresh
    // failure — the two events are distinct in the spec Logging table.
    const fireFailedWarns = capturedPrimeSink.filter(
      (r) =>
        r.channel === 'prime' &&
        r.level === 'warn' &&
        r.message === 'prime fire failed',
    )
    expect(fireFailedWarns).toHaveLength(0)
    await h.cleanup()
    setLogLevel(previousLevel)
    setLogLevelSource(previousLevel)
  })

  test('fire success emits info prime record; failure emits warn; skips emit debug/trace; payloads exclude secrets', async () => {
    const previousLevel = getLogLevel()
    setLogLevel('trace')
    setLogLevelSource('trace')
    const fixture = makePrimeFixture({
      mainQuota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    fixture.storage.accounts.push({
      id: 'work-alt',
      type: 'oauth',
      refresh: 'r',
      quota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(500).toISOString(),
          checkedAt: 1,
        },
      },
    })
    const futureReset = 500 + 5 * 60_000
    // A second fallback whose reset is in the future — eligible, but not yet
    // due, so the manager emits a trace skip record (covers the trace branch
    // of the canonical log table).
    fixture.storage.accounts.push({
      id: 'work-future',
      type: 'oauth',
      refresh: 'r',
      quota: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(futureReset).toISOString(),
          checkedAt: 1,
        },
      },
    })
    // An API-key account — surfaces the `not-oauth` debug eligibility skip.
    fixture.storage.accounts.push({
      id: 'apikey-acc',
      type: 'api',
      baseURL: 'https://example.com',
    })
    const now = 500 + 120_000
    const h = await makeHarness({
      storage: fixture.storage,
      markerDir: markerRoot,
      now,
      quotaFresh: {
        five_hour: {
          usedPercent: 0,
          remainingPercent: 100,
          resetsAt: new Date(now - 1000).toISOString(),
          checkedAt: 1,
        },
      },
      send: (id) => {
        if (id === 'work-alt') {
          return { ok: false, error: 'fire_failure', status: 500 }
        }
        return {
          ok: true,
          status: 200,
          ms: 1,
          usage: { inputTokens: 20, outputTokens: 1 },
        }
      },
    })
    await h.manager.tick()
    const prime = (m: string) =>
      capturedPrimeSink.filter((r) => r.channel === 'prime' && r.message === m)
    const pick = (
      records: LogTestRecord[],
      account: string,
    ): Record<string, unknown> | undefined => {
      for (const r of records) {
        const accountValue = (r.payload as { account?: unknown })?.account
        if (accountValue === account) {
          return r.payload as Record<string, unknown>
        }
      }
      return undefined
    }

    // -- main: fire success → info, label, status, ms, usage (nested object) --
    const fired = prime('prime fired')
    expect(fired).toHaveLength(1)
    const mainFire = pick(fired, 'main') as
      | {
          account: string
          status: number
          ms: number
          usage: { inputTokens: number; outputTokens: number }
        }
      | undefined
    expect(mainFire).toBeDefined()
    expect(mainFire?.status).toBe(200)
    expect(typeof mainFire?.ms).toBe('number')
    expect(mainFire?.usage).toBeDefined()
    expect(mainFire?.usage?.inputTokens).toBe(20)
    expect(mainFire?.usage?.outputTokens).toBe(1)

    // -- work-alt: fire failed → warn, label, status, error --
    const failed = prime('prime fire failed')
    expect(failed).toHaveLength(1)
    const fbFail = pick(failed, 'work-alt') as
      | { account: string; status?: number; error: string }
      | undefined
    expect(fbFail).toBeDefined()
    expect(fbFail?.status).toBe(500)
    expect(fbFail?.error).toBe('fire_failure')

    // -- apikey-acc: eligibility skip → debug, label, reason --
    const ineligible = prime('ineligible')
    expect(ineligible.length).toBeGreaterThanOrEqual(1)
    const apiSkip = pick(ineligible, 'apikey-acc') as
      | { account: string; reason: string }
      | undefined
    expect(apiSkip).toBeDefined()
    expect(apiSkip?.reason).toBe('API-key account')

    // -- work-future: not due → trace, label --
    const notDue = prime('not due')
    expect(notDue).toHaveLength(1)
    const futureSkip = pick(notDue, 'work-future') as
      | { account: string }
      | undefined
    expect(futureSkip).toBeDefined()

    // -- Lifecycle: manager started → trace, manager stopped → trace --
    h.manager.start()
    expect(
      capturedPrimeSink.some(
        (r) => r.channel === 'prime' && r.message === 'manager started',
      ),
    ).toBe(true)
    h.manager.stop()
    expect(
      capturedPrimeSink.some(
        (r) => r.channel === 'prime' && r.message === 'manager stopped',
      ),
    ).toBe(true)

    // No secret strings in any captured record.
    const serialized = JSON.stringify(capturedPrimeSink)
    expect(serialized).not.toContain('sk-ant-')
    expect(serialized).not.toContain('Bearer ')
    expect(serialized).not.toContain('eyJ')
    setLogLevel(previousLevel)
    setLogLevelSource(previousLevel)
    await h.cleanup()
  })
})
