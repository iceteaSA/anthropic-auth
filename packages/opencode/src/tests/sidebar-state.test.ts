import { describe, expect, test } from 'bun:test'
import {
  type AccountQuota,
  computeQuotaPacing,
  DEFAULT_SIDEBAR_STATE,
  FIVE_HOUR_MS,
  getCollapsedQuotaSummary,
  resolveActiveAccount,
  SEVEN_DAY_MS,
  type SidebarState,
} from '../sidebar-state'

const quota = (used: number): AccountQuota => ({
  five_hour: { usedPercent: used, remainingPercent: 100 - used },
  seven_day: { usedPercent: used, remainingPercent: 100 - used },
})

function make(overrides: Partial<SidebarState>): SidebarState {
  return { ...DEFAULT_SIDEBAR_STATE, ...overrides }
}

describe('resolveActiveAccount', () => {
  test('activeId "main" resolves to the main account', () => {
    const state = make({ activeId: 'main', main: { quota: quota(20) } })
    const active = resolveActiveAccount(state)
    expect(active.id).toBe('main')
    expect(active.name).toBe('main')
    expect(active.quota?.five_hour?.usedPercent).toBe(20)
  })

  test('activeId matching an enabled fallback resolves to that fallback (label name)', () => {
    const state = make({
      activeId: 'fb1',
      fallbacks: [
        { id: 'fb1', label: 'work', quota: quota(40), enabled: true },
      ],
    })
    const active = resolveActiveAccount(state)
    expect(active.id).toBe('fb1')
    expect(active.name).toBe('work')
    expect(active.quota?.five_hour?.usedPercent).toBe(40)
  })

  test('fallback without a label uses its id as the name', () => {
    const state = make({
      activeId: 'fb1',
      fallbacks: [
        { id: 'fb1', label: undefined, quota: quota(5), enabled: true },
      ],
    })
    expect(resolveActiveAccount(state).name).toBe('fb1')
  })

  test('activeId matching a DISABLED fallback falls back to main', () => {
    const state = make({
      activeId: 'fb1',
      main: { quota: quota(12) },
      fallbacks: [
        { id: 'fb1', label: 'work', quota: quota(40), enabled: false },
      ],
    })
    const active = resolveActiveAccount(state)
    expect(active.id).toBe('main')
    expect(active.quota?.five_hour?.usedPercent).toBe(12)
  })

  test('undefined activeId resolves to main', () => {
    const state = make({ activeId: undefined, main: { quota: quota(7) } })
    expect(resolveActiveAccount(state).id).toBe('main')
  })

  test('unmatched activeId resolves to main', () => {
    const state = make({
      activeId: 'ghost',
      main: { quota: null },
      fallbacks: [
        { id: 'fb1', label: 'work', quota: quota(40), enabled: true },
      ],
    })
    const active = resolveActiveAccount(state)
    expect(active.id).toBe('main')
    expect(active.quota).toBeNull()
  })
})

describe('getCollapsedQuotaSummary', () => {
  test('formats both active-account quota windows', () => {
    expect(getCollapsedQuotaSummary(quota(13)).text).toBe('5h: 13% 7d: 13%')
  })

  test('formats different 5h and 7d percentages', () => {
    expect(
      getCollapsedQuotaSummary({
        five_hour: { usedPercent: 13.4, remainingPercent: 86.6 },
        seven_day: { usedPercent: 7.2, remainingPercent: 92.8 },
      }).text,
    ).toBe('5h: 13% 7d: 7%')
  })

  test('uses a dash for a missing collapsed quota window', () => {
    expect(
      getCollapsedQuotaSummary({
        five_hour: { usedPercent: 13, remainingPercent: 87 },
      }).text,
    ).toBe('5h: 13% 7d: —')
  })

  test('returns no collapsed quota text when no windows are available', () => {
    expect(getCollapsedQuotaSummary(null).text).toBeNull()
    expect(getCollapsedQuotaSummary({}).text).toBeNull()
  })
})

describe('computeQuotaPacing', () => {
  const now = Date.UTC(2026, 5, 12, 12, 0, 0)

  function fiveHourWindow(elapsedMs: number, usedPercent: number) {
    return {
      window: {
        usedPercent,
        remainingPercent: 100 - usedPercent,
        resetsAt: new Date(now + FIVE_HOUR_MS - elapsedMs).toISOString(),
      },
      elapsedMs,
    }
  }

  test('reserve: under even-burn pace, lasts until reset', () => {
    const { window } = fiveHourWindow(FIVE_HOUR_MS / 4, 5)
    const pacing = computeQuotaPacing(window, FIVE_HOUR_MS, now)
    expect(pacing).not.toBeNull()
    expect(pacing?.pacePercent).toBeCloseTo(25, 5)
    expect(pacing?.deltaPercent).toBeCloseTo(-20, 5)
    expect(pacing?.state).toBe('reserve')
    expect(pacing?.runsOutAt).toBeNull()
  })

  test('deficit: over pace, projects runout before reset', () => {
    const elapsed = FIVE_HOUR_MS / 4
    const { window } = fiveHourWindow(elapsed, 50)
    const pacing = computeQuotaPacing(window, FIVE_HOUR_MS, now)
    expect(pacing?.pacePercent).toBeCloseTo(25, 5)
    expect(pacing?.deltaPercent).toBeCloseTo(25, 5)
    expect(pacing?.state).toBe('deficit')
    const start = now - elapsed
    expect(pacing?.runsOutAt).toBe(new Date(start + elapsed * 2).toISOString())
  })

  test('screenshot case: 7d window, 12h elapsed, 17% used', () => {
    const elapsed = 12 * 60 * 60 * 1000
    const window = {
      usedPercent: 17,
      remainingPercent: 83,
      resetsAt: new Date(now + SEVEN_DAY_MS - elapsed).toISOString(),
    }
    const pacing = computeQuotaPacing(window, SEVEN_DAY_MS, now)
    expect(pacing?.deltaPercent).toBeCloseTo(17 - (12 / 168) * 100, 5)
    expect(pacing?.state).toBe('deficit')
    expect(pacing?.runsOutAt).not.toBeNull()
    const runsOutMs = new Date(pacing?.runsOutAt as string).getTime() - now
    const expectedMs = (elapsed * 100) / 17 - elapsed
    expect(runsOutMs).toBeCloseTo(expectedMs, -4)
  })

  test('on-pace when |delta| < 1', () => {
    const { window } = fiveHourWindow(FIVE_HOUR_MS / 4, 25.5)
    const pacing = computeQuotaPacing(window, FIVE_HOUR_MS, now)
    expect(pacing?.state).toBe('on-pace')
  })

  test('zero usage is reserve and lasts', () => {
    const { window } = fiveHourWindow(FIVE_HOUR_MS / 2, 0)
    const pacing = computeQuotaPacing(window, FIVE_HOUR_MS, now)
    expect(pacing?.state).toBe('reserve')
    expect(pacing?.deltaPercent).toBeCloseTo(-50, 5)
    expect(pacing?.runsOutAt).toBeNull()
  })

  test('projection landing exactly at reset means lasts', () => {
    const elapsed = FIVE_HOUR_MS / 2
    const { window } = fiveHourWindow(elapsed, 50)
    const pacing = computeQuotaPacing(window, FIVE_HOUR_MS, now)
    expect(pacing?.state).toBe('on-pace')
    expect(pacing?.runsOutAt).toBeNull()
  })

  test('null when resetsAt missing or invalid', () => {
    expect(
      computeQuotaPacing(
        { usedPercent: 10, remainingPercent: 90 },
        FIVE_HOUR_MS,
        now,
      ),
    ).toBeNull()
    expect(
      computeQuotaPacing(
        { usedPercent: 10, remainingPercent: 90, resetsAt: 'garbage' },
        FIVE_HOUR_MS,
        now,
      ),
    ).toBeNull()
  })

  test('null in the early-window noise guard', () => {
    const fourMinutes = 4 * 60 * 1000
    const { window } = fiveHourWindow(fourMinutes, 3)
    expect(computeQuotaPacing(window, FIVE_HOUR_MS, now)).toBeNull()
    const oneHour = 60 * 60 * 1000
    const sevenDay = {
      usedPercent: 3,
      remainingPercent: 97,
      resetsAt: new Date(now + SEVEN_DAY_MS - oneHour).toISOString(),
    }
    expect(computeQuotaPacing(sevenDay, SEVEN_DAY_MS, now)).toBeNull()
  })

  test('null when elapsed reaches or exceeds the window', () => {
    const { window } = fiveHourWindow(FIVE_HOUR_MS, 80)
    expect(computeQuotaPacing(window, FIVE_HOUR_MS, now)).toBeNull()
    const past = {
      usedPercent: 80,
      remainingPercent: 20,
      resetsAt: new Date(now - 1000).toISOString(),
    }
    expect(computeQuotaPacing(past, FIVE_HOUR_MS, now)).toBeNull()
  })
})
