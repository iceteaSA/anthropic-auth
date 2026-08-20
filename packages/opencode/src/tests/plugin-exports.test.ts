import { describe, expect, test } from 'bun:test'

describe('plugin module exports', () => {
  test('plugin module exports remain limited to loader-compatible factories and helpers', async () => {
    const pluginModule = await import('../index')

    expect(Object.keys(pluginModule).sort()).toEqual([
      'AnthropicAuthPlugin',
      'formatKillswitchBlockMessage',
      'primeQuotaSnapshotIsFreshSince',
      'resolveScopedDrivenBlock',
    ])
  })
})
