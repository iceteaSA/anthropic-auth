import { describe, expect, test } from 'bun:test'

import { fetchOAuthQuotaSnapshot } from '../accounts.ts'

const MAIN_USAGE_CAPTURE = {
  five_hour: { utilization: 4 },
  seven_day: { utilization: 13 },
  limits: [
    { kind: 'session', group: 'session', percent: 4, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 13, is_active: false },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 15,
      is_active: true,
      scope: { model: { id: null, display_name: 'Fable' } },
    },
  ],
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null },
  spend: null,
}

const TEAM_USAGE_CAPTURE = {
  five_hour: { utilization: 77 },
  seven_day: { utilization: 40 },
  limits: [
    { kind: 'session', group: 'session', percent: 77, is_active: true },
    { kind: 'weekly_all', group: 'weekly', percent: 40, is_active: false },
    {
      kind: 'weekly_scoped',
      group: 'weekly',
      percent: 51,
      is_active: false,
      scope: { model: { id: null, display_name: 'Fable' } },
    },
  ],
  extra_usage: {
    is_enabled: true,
    monthly_limit: 10000,
    used_credits: 10035,
    utilization: 100,
  },
  spend: {
    severity: 'critical',
    limit: { amount_minor: 10000, currency: 'USD', exponent: 2 },
    can_purchase_credits: false,
  },
}

async function snapshotFor(capture: unknown) {
  return fetchOAuthQuotaSnapshot({
    accessToken: 'test-token',
    now: () => 1_700_000_000_000,
    fetchImpl: (async () => Response.json(capture)) as unknown as typeof fetch,
  })
}

describe('quota surface normalization', () => {
  test('normalizes enabled exhausted extra usage from the Team capture', async () => {
    const team = await snapshotFor(TEAM_USAGE_CAPTURE)

    expect(team.extraUsage?.used.amountMinor).toBe(10035)
    expect(team.extraUsage?.limit.amountMinor).toBe(10000)
    expect(team.extraUsage?.severity).toBe('critical')
    expect(team.extraUsage?.exhausted).toBe(true)
    expect(team.source).toBe('poll')
  })

  test('omits extraUsage when the personal capture says is_enabled false', async () => {
    const main = await snapshotFor(MAIN_USAGE_CAPTURE)

    expect(main.extraUsage).toBeUndefined()
  })

  test('maps the active session limit to bindingWindow five_hour', async () => {
    const team = await snapshotFor(TEAM_USAGE_CAPTURE)

    expect(team.bindingWindow).toBe('five_hour')
    expect(team.bindingWindowSource).toBe('poll')
  })

  test('maps an active scoped limit to its wire-derived identity without coercing it to seven_day', async () => {
    const main = await snapshotFor(MAIN_USAGE_CAPTURE)

    expect(main.bindingWindow).toBe('claude-weekly-scoped-fable')
    expect(main.bindingWindowSource).toBe('poll')
  })
})
