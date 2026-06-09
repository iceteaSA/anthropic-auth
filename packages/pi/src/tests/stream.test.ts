import { describe, expect, test } from 'bun:test'

import {
  buildExplicitBaseMessagesUrl,
  configureApiRouteHeaders,
} from '../stream.ts'

describe('Pi API fallback routing helpers', () => {
  test('preserves provider base path when building /v1/messages URL', () => {
    const url = buildExplicitBaseMessagesUrl('https://api.kie.ai/claude')

    expect(url.toString()).toBe(
      'https://api.kie.ai/claude/v1/messages?beta=true',
    )
  })

  test('uses bearer auth by default for API fallback routes', () => {
    const headers = configureApiRouteHeaders(
      {
        id: 'kie-opus',
        type: 'api',
        apiKey: 'kie-key',
        baseURL: 'https://api.kie.ai/claude',
        authHeader: 'authorization-bearer',
      },
      false,
    )

    expect(headers.get('authorization')).toBe('Bearer kie-key')
    expect(headers.get('x-api-key')).toBeNull()
    expect(headers.get('anthropic-version')).toBe('2023-06-01')
    expect(headers.get('content-type')).toBe('application/json')
  })

  test('supports x-api-key auth mode for API fallback routes', () => {
    const headers = configureApiRouteHeaders(
      {
        id: 'provider-route',
        type: 'api',
        apiKey: 'provider-key',
        baseURL: 'https://provider.example/anthropic',
        authHeader: 'x-api-key',
      },
      true,
    )

    expect(headers.get('authorization')).toBeNull()
    expect(headers.get('x-api-key')).toBe('provider-key')
    expect(headers.get('anthropic-beta')).toContain('fast-mode-2026-02-01')
  })
})
