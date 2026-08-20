import { describe, expect, test } from 'bun:test'
import {
  applyCacheDiagnosticsOptIn,
  buildCacheDiagnosticsRecord,
  CACHE_DIAGNOSTICS_LOG_PREFIX,
  CacheDiagnosticsTracker,
  formatCacheDiagnosticsLogLine,
  summarizeCacheTtl,
  withStickyRetryAfter,
} from '../cache-diagnostics'

const usage = {
  input_tokens: 10,
  cache_read_input_tokens: 20,
  cache_creation_input_tokens: 30,
  cache_creation: {
    ephemeral_5m_input_tokens: 40,
    ephemeral_1h_input_tokens: 50,
  },
}

const message = (diagnostics?: unknown) => ({
  id: 'provider-response-id-with-no-msg-prefix',
  model: 'claude-opus-4-7',
  usage,
  ...(diagnostics === undefined ? {} : { diagnostics }),
})

describe('CacheDiagnosticsTracker', () => {
  test('returns null before capture and preserves opaque provider ids', () => {
    const tracker = new CacheDiagnosticsTracker()
    expect(tracker.previousFor('ses-a')).toBeNull()
    tracker.capture('ses-a', 'provider-response-id-with-no-msg-prefix', 100)
    expect(tracker.previousFor('ses-a')).toEqual({
      messageId: 'provider-response-id-with-no-msg-prefix',
      receivedAt: 100,
    })
    tracker.capture('ses-a', 'ses-opencode-decoy', 200)
    expect(tracker.previousFor('ses-a')?.messageId).toBe('ses-opencode-decoy')
  })

  test('evicts only the oldest unique session at the bounded limit', () => {
    const tracker = new CacheDiagnosticsTracker()
    for (let index = 0; index < 1_000; index += 1)
      tracker.capture(`ses-${index}`, `provider-${index}`, index)
    tracker.capture('ses-0', 'provider-0-updated', 2_000)
    tracker.capture('ses-1000', 'provider-1000', 2_001)
    expect(tracker.previousFor('ses-0')).toBeNull()
    expect(tracker.previousFor('ses-1')?.messageId).toBe('provider-1')
  })

  test('copies response context across a sticky retry rewrap', async () => {
    const contexts = new WeakMap<Response, unknown>()
    const source = new Response('{}')
    contexts.set(source, { sessionId: 'ses-retry' })

    const destination = await withStickyRetryAfter(
      source,
      'ses-retry',
      60,
      false,
      contexts,
    )

    expect(contexts.get(destination)).toEqual({ sessionId: 'ses-retry' })
  })
})

describe('cache diagnostics contract', () => {
  test.each([
    [{}, 'absent'],
    [{ diagnostics: null }, 'server_null'],
    [{ diagnostics: { cache_miss_reason: null } }, 'pending'],
    [
      { diagnostics: { cache_miss_reason: { type: 'unavailable' } } },
      'populated',
    ],
  ] as const)('classifies diagnostics %j as %s', (extra, state) => {
    expect(
      buildCacheDiagnosticsRecord({
        request: {
          sessionId: 'ses-a',
          previousMessageId: null,
          isSubagent: false,
          ttlSent: '1h',
        },
        message: { ...message(undefined), ...extra },
        receivedAt: 100,
      }).record?.diag_state,
    ).toBe(state)
  })

  test('copies usage values by property and keeps unavailable ordinary', () => {
    const result = buildCacheDiagnosticsRecord({
      request: {
        sessionId: 'ses-a',
        previousMessageId: null,
        isSubagent: true,
        ttlSent: '5m',
      },
      message: message({
        cache_miss_reason: {
          type: 'unavailable',
          cache_missed_input_tokens: 99,
        },
      }),
      receivedAt: 100,
    })
    expect(result.record).toMatchObject({
      is_subagent: true,
      cache_read: 20,
      cache_creation: 30,
      input_tokens: 10,
      ephemeral_5m_tokens: 40,
      ephemeral_1h_tokens: 50,
      miss_reason: 'unavailable',
      cache_missed_input_tokens: 99,
    })
  })

  test('parses the verbatim captured populated API response', () => {
    // This fixture is a verbatim captured API response; do not simplify it.
    const result = buildCacheDiagnosticsRecord({
      request: {
        sessionId: 'ses-a',
        previousMessageId: null,
        isSubagent: false,
        ttlSent: '1h',
      },
      message: {
        id: 'msg_011SampleAnthropicId0000',
        model: 'claude-opus-5',
        usage: {
          input_tokens: 14,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 24837,
          cache_creation: {
            ephemeral_5m_input_tokens: 0,
            ephemeral_1h_input_tokens: 24837,
          },
        },
        diagnostics: {
          cache_miss_reason: {
            type: 'system_changed',
            cache_missed_input_tokens: 23963,
          },
        },
      },
      receivedAt: 100,
    })
    expect(result.record).toMatchObject({
      diag_state: 'populated',
      miss_reason: 'system_changed',
      cache_missed_input_tokens: 23963,
    })
  })

  test('rejects malformed diagnostics without fabricating absent state', () => {
    const result = buildCacheDiagnosticsRecord({
      request: {
        sessionId: 'ses-a',
        previousMessageId: null,
        isSubagent: false,
        ttlSent: null,
      },
      message: message({ cache_miss_reason: 42 }),
      receivedAt: 100,
    })
    expect(result).toEqual({})
  })

  test.each([
    { cache_miss_reason: 'system_changed' },
    { cache_miss_reason: {} },
    { cache_miss_reason: { type: 42 } },
  ])('rejects non-wire populated reason %j', (reason) => {
    expect(
      buildCacheDiagnosticsRecord({
        request: {
          sessionId: 'ses-a',
          previousMessageId: null,
          isSubagent: false,
          ttlSent: null,
        },
        message: message(reason),
        receivedAt: 100,
      }),
    ).toEqual({})
  })

  test.each([
    { diagnostics: 'pending' },
    { diagnostics: [] },
    { diagnostics: 42 },
  ])('rejects malformed diagnostics shape %j', (extra) => {
    expect(
      buildCacheDiagnosticsRecord({
        request: {
          sessionId: 'ses-a',
          previousMessageId: null,
          isSubagent: false,
          ttlSent: null,
        },
        message: { ...message(), ...extra },
        receivedAt: 100,
      }),
    ).toEqual({})
  })

  test('rejects non-finite and fractional receipt timestamps', () => {
    const request = {
      sessionId: 'ses-a',
      previousMessageId: null,
      isSubagent: false,
      ttlSent: null as null,
    }
    expect(
      buildCacheDiagnosticsRecord({
        request,
        message: message(),
        receivedAt: 100.5,
      }),
    ).toEqual({})
    expect(
      buildCacheDiagnosticsRecord({
        request,
        message: message(),
        receivedAt: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({})
  })

  test('applies opt-in without replacing existing body fields', () => {
    const body: Record<string, unknown> = { model: 'x' }
    applyCacheDiagnosticsOptIn(body, null)
    expect(body).toEqual({
      model: 'x',
      diagnostics: { previous_message_id: null },
    })
  })

  test.each([
    [{ cache_control: { type: 'ephemeral', ttl: '1h' } }, '1h'],
    [{ cache_control: { type: 'ephemeral' } }, '5m'],
    [{}, null],
    [
      {
        cache_control: { type: 'ephemeral', ttl: '1h' },
        system: [{ cache_control: { type: 'ephemeral' } }],
      },
      '5m',
    ],
    [
      {
        system: [{ cache_control: { type: 'ephemeral' } }],
        messages: [
          { content: [{ cache_control: { type: 'ephemeral', ttl: '1h' } }] },
        ],
      },
      '1h',
    ],
    [
      {
        system: [
          {},
          {},
          {},
          { cache_control: { type: 'ephemeral', ttl: '1h' } },
        ],
        messages: [
          {
            content: [
              { cache_control: { type: 'ephemeral', ttl: '1h' } },
              { cache_control: { type: 'ephemeral', ttl: '1h' } },
            ],
          },
          { content: [{ cache_control: { type: 'ephemeral', ttl: '1h' } }] },
        ],
      },
      '1h',
    ],
    [
      {
        system: [{ cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            content: [
              {
                type: 'tool_use',
                input: { cache_control: { type: 'ephemeral', ttl: '1h' } },
              },
            ],
          },
        ],
      },
      '5m',
    ],
  ] as const)('summarizes TTL as %s', (body, expected) => {
    expect(summarizeCacheTtl(body)).toBe(expected)
  })

  test('formats one machine line with the v1 record', () => {
    const result = buildCacheDiagnosticsRecord({
      request: {
        sessionId: 'ses-a',
        previousMessageId: null,
        isSubagent: false,
        ttlSent: '1h',
      },
      message: message(),
      receivedAt: 100,
    })
    expect(result.record).toBeDefined()
    const line = formatCacheDiagnosticsLogLine(result.record!)
    expect(line.startsWith(CACHE_DIAGNOSTICS_LOG_PREFIX)).toBe(true)
    expect(
      JSON.parse(line.slice(CACHE_DIAGNOSTICS_LOG_PREFIX.length)),
    ).toMatchObject({
      v: 1,
      session_id: 'ses-a',
      message_id: 'provider-response-id-with-no-msg-prefix',
    })
  })

  test('emits a short-gap canary only for previous_message_not_found', () => {
    const result = buildCacheDiagnosticsRecord({
      request: {
        sessionId: 'ses-a',
        previousMessageId: 'provider-previous',
        previousMessageReceivedAt: 1_000,
        isSubagent: false,
        ttlSent: null,
      },
      message: message({
        cache_miss_reason: { type: 'previous_message_not_found' },
      }),
      receivedAt: 1_000 + 5 * 60_000 - 1,
    })
    expect(result.canary).toEqual({
      messageId: 'provider-response-id-with-no-msg-prefix',
      previousMessageId: 'provider-previous',
    })
  })

  test.each([
    { reason: 'unavailable', previousMessageId: 'provider-previous', age: 1 },
    {
      reason: 'previous_message_not_found',
      previousMessageId: 'provider-previous',
      age: 5 * 60_000,
    },
    {
      reason: 'previous_message_not_found',
      previousMessageId: null,
      age: 1,
    },
  ])('does not emit a canary for %j', ({ reason, previousMessageId, age }) => {
    const previousReceivedAt = 1_000
    const result = buildCacheDiagnosticsRecord({
      request: {
        sessionId: 'ses-a',
        previousMessageId,
        previousMessageReceivedAt: previousReceivedAt,
        isSubagent: false,
        ttlSent: null,
      },
      message: message({ cache_miss_reason: { type: reason } }),
      receivedAt: previousReceivedAt + age,
    })
    expect(result.canary).toBeUndefined()
  })
})
