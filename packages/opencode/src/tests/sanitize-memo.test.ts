import { describe, expect, test } from 'bun:test'
import { makeByteBoundedMemo } from '../sanitize-memo'

describe('makeByteBoundedMemo', () => {
  test('computes on miss and returns cached value on hit (fn runs once)', () => {
    let calls = 0
    const memo = makeByteBoundedMemo(
      (k) => {
        calls++
        return `<${k}>`
      },
      { maxBytes: 1024, enabled: () => true },
    )
    expect(memo.call('a')).toBe('<a>')
    expect(memo.call('a')).toBe('<a>')
    expect(calls).toBe(1)
    const s = memo.stats()
    expect(s.hits).toBe(1)
    expect(s.misses).toBe(1)
    expect(s.entries).toBe(1)
  })

  test('evicts oldest until under the byte budget (LRU recency on hit)', () => {
    // entryBytes = key.length + value.length = 1 + 10 = 11; budget ~= 2 entries
    const memo = makeByteBoundedMemo((k) => k.repeat(10), {
      maxBytes: 24,
      enabled: () => true,
    })
    memo.call('a')
    memo.call('b')
    memo.call('a') // hit -> 'a' becomes most-recently-used
    memo.call('c') // insert -> evicts least-recently-used ('b')
    const s = memo.stats()
    expect(s.cacheBytes).toBeLessThanOrEqual(24)
    expect(s.entries).toBeLessThanOrEqual(2)
    expect(s.evictions).toBeGreaterThanOrEqual(1)
    expect(s.hits).toBe(1)
  })

  test('does not cache an entry larger than the budget (oversize guard)', () => {
    let calls = 0
    const memo = makeByteBoundedMemo(
      (k) => {
        calls++
        return k.repeat(100) // huge value
      },
      { maxBytes: 16, enabled: () => true },
    )
    expect(memo.call('x')).toBe('x'.repeat(100))
    expect(memo.call('x')).toBe('x'.repeat(100))
    expect(calls).toBe(2) // never cached -> recomputed each time
    expect(memo.stats().entries).toBe(0)
  })

  test('disabled: bypasses cache but still records misses/computeMs', () => {
    let calls = 0
    const memo = makeByteBoundedMemo(
      (k) => {
        calls++
        return k.toUpperCase()
      },
      { maxBytes: 1024, enabled: () => false },
    )
    expect(memo.call('a')).toBe('A')
    expect(memo.call('a')).toBe('A')
    expect(calls).toBe(2)
    const s = memo.stats()
    expect(s.hits).toBe(0)
    expect(s.misses).toBe(2)
    expect(s.entries).toBe(0)
  })
})
