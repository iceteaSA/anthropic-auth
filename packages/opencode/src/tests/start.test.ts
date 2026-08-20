import { describe, expect, test } from 'bun:test'
import {
  buildLaneStartStatusSummary,
  executeLaneStartCommand,
  parseLaneStartCommandAction,
} from '@cortexkit/anthropic-auth-core'

describe('claude-start command contract', () => {
  test('bare and whitespace-only input queues a start turn', () => {
    expect(parseLaneStartCommandAction('')).toEqual({ type: 'fire' })
    expect(parseLaneStartCommandAction('  \t')).toEqual({ type: 'fire' })
    expect(
      executeLaneStartCommand({ argumentsText: ' ', automaticEnabled: false }),
    ).toEqual({
      action: { type: 'fire' },
      text: expect.stringContaining('Queued'),
    })
  })

  test('automatic reports unavailable without claiming persistence', () => {
    expect(parseLaneStartCommandAction('automatic')).toEqual({
      type: 'automatic',
    })
    const result = executeLaneStartCommand({
      argumentsText: 'automatic',
      automaticEnabled: false,
    })
    expect(result.action).toEqual({ type: 'automatic' })
    expect(result.text).toBe(
      'Automatic lane start is not yet wired in this build; no setting was changed.',
    )
    expect(result.text).not.toContain('Persisted:')
  })

  test('off reports disabled and preserves explicit persistence wording', () => {
    expect(parseLaneStartCommandAction('off')).toEqual({ type: 'off' })
    const result = executeLaneStartCommand({
      argumentsText: 'off',
      automaticEnabled: true,
    })
    expect(result.action).toEqual({ type: 'off' })
    expect(result.text).toContain('Disabled')
    expect(result.text).toContain(
      'Persisted: ~/.config/opencode/anthropic-auth.json',
    )
  })

  test('multiple or invalid arguments return usage', () => {
    expect(parseLaneStartCommandAction('automatic now')).toEqual({
      type: 'usage',
    })
    expect(parseLaneStartCommandAction('unknown')).toEqual({ type: 'usage' })
    const result = executeLaneStartCommand({
      argumentsText: 'unknown',
      automaticEnabled: false,
    })
    expect(result.action).toEqual({ type: 'usage' })
    expect(result.text).toContain(
      'Usage: `/claude-start`, `/claude-start automatic`, or `/claude-start off`.',
    )
  })

  test('status summary reports automatic state and side-effect scope', () => {
    const enabled = buildLaneStartStatusSummary({ automaticEnabled: true })
    const disabled = buildLaneStartStatusSummary({ automaticEnabled: false })
    expect(enabled).toContain('Enabled: enabled')
    expect(disabled).toContain('Enabled: disabled')
    expect(enabled).toContain(
      'Persisted: ~/.config/opencode/anthropic-auth.json',
    )
    expect(enabled).toContain('automatic lane starts are not yet wired')
  })
})
