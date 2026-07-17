import { describe, expect, test } from 'bun:test'

import { formatQuotaMoney } from '../tui'

describe('formatQuotaMoney', () => {
  test('falls back for malformed currency and exponent metadata', () => {
    expect(
      formatQuotaMoney({
        amountMinor: 10035,
        currency: 'ZZZZ',
        exponent: 50,
      }),
    ).toBe('10035 ZZZZ')
  })
})
