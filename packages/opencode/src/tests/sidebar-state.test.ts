import { describe, expect, test } from 'bun:test'
import {
  type AccountQuota,
  DEFAULT_SIDEBAR_STATE,
  getCollapsedQuotaSummary,
  resolveActiveAccount,
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
