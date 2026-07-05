import { describe, expect, test } from 'bun:test'

import {
  type AccountScopedQuotaWindow,
  type AccountStorage,
  DEFAULT_KILLSWITCH_THRESHOLDS,
  getKillswitchThresholdsForAccount,
  killswitchPassesPolicy,
  killswitchRetryAfterSeconds,
  normalizeKillswitchThresholds,
  type OAuthQuotaSnapshot,
} from '../accounts.ts'
import {
  executeKillswitchCommand,
  parseKillswitchCommandAction,
} from '../killswitch.ts'

const baseStorage = (): AccountStorage => ({
  version: 1,
  main: { type: 'opencode', provider: 'anthropic' },
  fallbackOn: [401, 403, 429],
  quota: {
    enabled: true,
    checkIntervalMinutes: 5,
    minimumRemaining: { five_hour: 10, seven_day: 20 },
    failClosedOnUnknownQuota: true,
  },
  accounts: [],
})

const scopeWindow = (
  remainingPercent: number,
  model: { name: string; id?: string },
  overrides: Partial<AccountScopedQuotaWindow> = {},
): AccountScopedQuotaWindow => ({
  usedPercent: 100 - remainingPercent,
  remainingPercent,
  checkedAt: Date.now(),
  id: 'claude-weekly-scoped-fable',
  title: `${model.name} only`,
  modelName: model.name,
  ...(model.id && { modelId: model.id }),
  ...overrides,
})

const healthy5h7d = (): Pick<
  OAuthQuotaSnapshot,
  'five_hour' | 'seven_day'
> => ({
  five_hour: {
    usedPercent: 50,
    remainingPercent: 50,
    checkedAt: Date.now(),
  },
  seven_day: {
    usedPercent: 20,
    remainingPercent: 80,
    checkedAt: Date.now(),
  },
})

// ---------------------------------------------------------------------------
// DEFAULT_KILLSWITCH_THRESHOLDS / normalizeKillswitchThresholds
// ---------------------------------------------------------------------------
describe('scoped killswitch — defaults + normalization', () => {
  test('DEFAULT_KILLSWITCH_THRESHOLDS.scoped is 0', () => {
    expect(DEFAULT_KILLSWITCH_THRESHOLDS.scoped).toBe(0)
  })

  test('normalizeKillswitchThresholds resolves scoped to default 0 when absent', () => {
    const t = normalizeKillswitchThresholds({ five_hour: 5, seven_day: 10 })
    expect(t.scoped).toBe(0)
  })

  test('normalizeKillswitchThresholds preserves an explicit scoped value', () => {
    const t = normalizeKillswitchThresholds({
      five_hour: 5,
      seven_day: 10,
      scoped: 20,
    })
    expect(t.scoped).toBe(20)
  })

  test('normalizeKillswitchThresholds falls back to default for non-finite scoped', () => {
    const t = normalizeKillswitchThresholds({
      five_hour: 5,
      seven_day: 10,
      scoped: Number.NaN,
    })
    expect(t.scoped).toBe(0)

    const inf = normalizeKillswitchThresholds({
      five_hour: 5,
      seven_day: 10,
      scoped: Number.POSITIVE_INFINITY,
    })
    expect(inf.scoped).toBe(0)
  })

  test('getKillswitchThresholdsForAccount carries scoped', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10, scoped: 20 },
    }
    expect(getKillswitchThresholdsForAccount(storage).scoped).toBe(20)
    expect(getKillswitchThresholdsForAccount(storage, 'work-alt').scoped).toBe(
      20,
    )
  })
})

// ---------------------------------------------------------------------------
// killswitchPassesPolicy — model-scoped additive behavior
// ---------------------------------------------------------------------------
describe('killswitchPassesPolicy — scoped model dimension', () => {
  test('modelId absent: byte-identical to pre-change (no scoped evaluation)', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10, scoped: 100 },
    }
    const quota: OAuthQuotaSnapshot = {
      ...healthy5h7d(),
      // a fully exhausted scoped window is present, but no modelId is provided
      // → the killswitch must NOT touch it (regression lock for the additive
      //   semantics).
      scoped: [
        scopeWindow(0, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    }
    expect(killswitchPassesPolicy(quota, storage)).toBe(true)
  })

  test('matching model + scoped window at/below threshold → blocks', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10, scoped: 0 },
    }
    const quota: OAuthQuotaSnapshot = {
      ...healthy5h7d(),
      scoped: [
        scopeWindow(0, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    }
    expect(
      killswitchPassesPolicy(quota, storage, undefined, 'claude-fable-5'),
    ).toBe(false)
  })

  test('NON-matching model + scoped-exhausted window → account stays live (the model-scoped proof)', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10, scoped: 0 },
    }
    const quota: OAuthQuotaSnapshot = {
      ...healthy5h7d(),
      scoped: [
        scopeWindow(0, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    }
    // Sonnet — not in the Fable scope — must pass even though Fable is exhausted.
    expect(
      killswitchPassesPolicy(quota, storage, undefined, 'claude-sonnet-5'),
    ).toBe(true)
  })

  test('matching model + scoped window ABOVE threshold → passes', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10, scoped: 0 },
    }
    const quota: OAuthQuotaSnapshot = {
      ...healthy5h7d(),
      scoped: [
        scopeWindow(50, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    }
    expect(
      killswitchPassesPolicy(quota, storage, undefined, 'claude-fable-5'),
    ).toBe(true)
  })

  test('5h/7d below threshold blocks regardless of scoped state', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 10, seven_day: 10, scoped: 0 },
    }
    const quota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 95,
        remainingPercent: 5,
        checkedAt: Date.now(),
      },
      seven_day: {
        usedPercent: 20,
        remainingPercent: 80,
        checkedAt: Date.now(),
      },
      // Fable has plenty of headroom — must still block via 5h.
      scoped: [
        scopeWindow(80, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    }
    expect(killswitchPassesPolicy(quota, storage)).toBe(false)
  })

  test('default scoped 0: blocks at remainingPercent <= 0 only (inclusive)', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10 },
    }
    const remainingOne = {
      ...healthy5h7d(),
      scoped: [
        scopeWindow(1, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    } as OAuthQuotaSnapshot
    // 1% remaining — above the default 0 → pass
    expect(
      killswitchPassesPolicy(
        remainingOne,
        storage,
        undefined,
        'claude-fable-5',
      ),
    ).toBe(true)

    const exactlyZero = {
      ...healthy5h7d(),
      scoped: [
        scopeWindow(0, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    } as OAuthQuotaSnapshot
    // 0% remaining — must block (inclusive boundary)
    expect(
      killswitchPassesPolicy(exactlyZero, storage, undefined, 'claude-fable-5'),
    ).toBe(false)
  })

  test('raised scoped threshold (20) blocks at <= 20', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10, scoped: 20 },
    }
    const quota21 = {
      ...healthy5h7d(),
      scoped: [
        scopeWindow(21, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    } as OAuthQuotaSnapshot
    expect(
      killswitchPassesPolicy(quota21, storage, undefined, 'claude-fable-5'),
    ).toBe(true)

    const quota20 = {
      ...healthy5h7d(),
      scoped: [
        scopeWindow(20, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    } as OAuthQuotaSnapshot
    expect(
      killswitchPassesPolicy(quota20, storage, undefined, 'claude-fable-5'),
    ).toBe(false)

    const quota5 = {
      ...healthy5h7d(),
      scoped: [
        scopeWindow(5, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    } as OAuthQuotaSnapshot
    expect(
      killswitchPassesPolicy(quota5, storage, undefined, 'claude-fable-5'),
    ).toBe(false)
  })

  test('non-finite scoped remainingPercent → not blocked', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10, scoped: 0 },
    }
    const quota = {
      ...healthy5h7d(),
      scoped: [
        {
          usedPercent: 0,
          remainingPercent: Number.NaN,
          checkedAt: Date.now(),
          id: 'claude-weekly-scoped-fable',
          title: 'Claude Fable 5 only',
          modelName: 'Claude Fable 5',
          modelId: 'claude-fable-5',
        },
      ],
    } as OAuthQuotaSnapshot
    expect(
      killswitchPassesPolicy(quota, storage, undefined, 'claude-fable-5'),
    ).toBe(true)
  })

  test('generic: a non-Fable display_name scoped window behaves identically (no hardcoded string)', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10, scoped: 0 },
    }
    // Pretend the future carve-out has a different display name; the keying
    // in getScopedQuotaWindowForModel is via the `fable`/`mythos` substring
    // (or future model keys), so we use a key that the matcher recognises.
    const quota: OAuthQuotaSnapshot = {
      ...healthy5h7d(),
      scoped: [
        scopeWindow(0, { name: 'Claude Mythos 5', id: 'claude-mythos-5' }),
      ],
    }
    expect(
      killswitchPassesPolicy(quota, storage, undefined, 'claude-mythos-5'),
    ).toBe(false)
    // Sonnet still untouched
    expect(
      killswitchPassesPolicy(quota, storage, undefined, 'claude-sonnet-5'),
    ).toBe(true)
  })

  test('a model with no matching scoped window is unaffected by the scoped check', () => {
    const storage = baseStorage()
    storage.killswitch = {
      enabled: true,
      main: { five_hour: 5, seven_day: 10, scoped: 0 },
    }
    const quota = healthy5h7d() // no `scoped` array
    expect(
      killswitchPassesPolicy(quota, storage, undefined, 'claude-fable-5'),
    ).toBe(true)
  })

  test('killswitch disabled → scoped check never runs', () => {
    const storage = baseStorage()
    // killswitch NOT enabled; even with a present scoped window and a model
    // that would otherwise match, the function must short-circuit to true.
    const quota: OAuthQuotaSnapshot = {
      ...healthy5h7d(),
      scoped: [
        scopeWindow(0, { name: 'Claude Fable 5', id: 'claude-fable-5' }),
      ],
    }
    expect(
      killswitchPassesPolicy(quota, storage, undefined, 'claude-fable-5'),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// parseKillswitchCommandAction / executeKillswitchCommand — scoped column
// ---------------------------------------------------------------------------
describe('parseKillswitchCommandAction — scoped three-number form', () => {
  test('two-number form still parses (backward compatibility)', () => {
    expect(parseKillswitchCommandAction('set main:3,8')).toEqual({
      type: 'set',
      entries: [{ account: 'main', fh: 3, sd: 8, scoped: undefined }],
    })
  })

  test('three-number form parses fh/sd/scoped', () => {
    expect(parseKillswitchCommandAction('set main:80,10,0')).toEqual({
      type: 'set',
      entries: [{ account: 'main', fh: 80, sd: 10, scoped: 0 }],
    })
  })

  test('three-number form with non-zero scoped threshold', () => {
    expect(parseKillswitchCommandAction('set all:80,10,20')).toEqual({
      type: 'set',
      entries: [{ account: 'all', fh: 80, sd: 10, scoped: 20 }],
    })
  })

  test('mixed: one entry with scoped, one without', () => {
    expect(
      parseKillswitchCommandAction('set main:80,10,0 work-alt:5,10'),
    ).toEqual({
      type: 'set',
      entries: [
        { account: 'main', fh: 80, sd: 10, scoped: 0 },
        { account: 'work-alt', fh: 5, sd: 10, scoped: undefined },
      ],
    })
  })

  test('per-account scoped threshold round-trips through the command', () => {
    const result = executeKillswitchCommand({
      argumentsText: 'set main:5,10 work-alt:80,10,15',
      config: { enabled: true, main: { five_hour: 5, seven_day: 10 } },
      accountIds: ['work-alt'],
    })
    expect(result.updatedConfig?.accounts?.['work-alt']?.scoped).toBe(15)
    // main did not specify a scoped threshold in this command, so it should
    // fall back to the default (0) on normalization, not retain an arbitrary
    // value. The command itself only writes what was parsed.
    expect(result.updatedConfig?.main?.scoped).toBeUndefined()
  })

  test('status table renders the Scoped column when enabled', () => {
    const result = executeKillswitchCommand({
      argumentsText: 'set main:5,10,20 work-alt:80,10,15',
      config: { enabled: false },
      accountIds: ['work-alt'],
    })
    expect(result.text).toContain('Scoped')
    expect(result.text).toContain('main')
    expect(result.text).toContain('work-alt')
  })
})

// ---------------------------------------------------------------------------
// killswitchRetryAfterSeconds — scoped window resetsAt
// ---------------------------------------------------------------------------
describe('killswitchRetryAfterSeconds — scoped resetsAt', () => {
  test('considers the matched scoped window resetsAt when present', () => {
    const now = Date.now()
    const mainQuota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 50,
        remainingPercent: 50,
        checkedAt: now,
      },
    }
    // A Fable window 3 minutes out — should be the earliest reset.
    const fallbacks = [
      {
        quota: {
          five_hour: {
            usedPercent: 50,
            remainingPercent: 50,
            resetsAt: new Date(now + 600_000).toISOString(), // 10 min
            checkedAt: now,
          },
          scoped: [
            scopeWindow(
              0,
              { name: 'Claude Fable 5', id: 'claude-fable-5' },
              {
                resetsAt: new Date(now + 180_000).toISOString(), // 3 min
              },
            ),
          ],
        },
      },
    ]
    const seconds = killswitchRetryAfterSeconds(
      mainQuota,
      fallbacks,
      now,
      'claude-fable-5',
    )
    // 180s until reset + 60s buffer
    expect(seconds).toBeGreaterThanOrEqual(239)
    expect(seconds).toBeLessThanOrEqual(241)
  })

  test('omitting scoped resetsAt is backward-compatible', () => {
    const now = Date.now()
    const mainQuota: OAuthQuotaSnapshot = {
      five_hour: {
        usedPercent: 50,
        remainingPercent: 50,
        checkedAt: now,
      },
    }
    const fallbacks = [
      {
        quota: {
          five_hour: {
            usedPercent: 50,
            remainingPercent: 50,
            resetsAt: new Date(now + 300_000).toISOString(),
            checkedAt: now,
          },
        },
      },
    ]
    const seconds = killswitchRetryAfterSeconds(mainQuota, fallbacks, now)
    expect(seconds).toBeGreaterThanOrEqual(359)
    expect(seconds).toBeLessThanOrEqual(361)
  })
})
