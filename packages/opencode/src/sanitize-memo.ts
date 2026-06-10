export type SanitizeMemoStats = {
  hits: number
  misses: number
  evictions: number
  entries: number
  cacheBytes: number
  computeMsTotal: number
}

/**
 * Generic byte-bounded LRU memo for a pure `(key: string) => string` function.
 * - Hit: move-to-end (true LRU recency).
 * - Miss: compute (timed), insert, then evict oldest until total bytes <= budget.
 * - Oversize (single entry > budget): compute but do not cache (no thrash).
 * - Disabled: bypass the cache; still record misses/computeMs (measurable baseline).
 * Byte size is approximated by UTF-16 length (key.length + value.length).
 */
export function makeByteBoundedMemo(
  fn: (key: string) => string,
  opts: { maxBytes: number; enabled: () => boolean },
): { call: (key: string) => string; stats: () => SanitizeMemoStats } {
  const cache = new Map<string, string>()
  let cacheBytes = 0
  let hits = 0
  let misses = 0
  let evictions = 0
  let computeMsTotal = 0

  const compute = (key: string): string => {
    const start = performance.now()
    const value = fn(key)
    computeMsTotal += performance.now() - start
    misses++
    return value
  }

  const call = (key: string): string => {
    if (!opts.enabled()) return compute(key)

    const cached = cache.get(key)
    if (cached !== undefined) {
      hits++
      cache.delete(key)
      cache.set(key, cached) // move-to-end: LRU recency
      return cached
    }

    const value = compute(key)
    const entryBytes = key.length + value.length
    if (entryBytes > opts.maxBytes) return value // oversize: do not cache

    cache.set(key, value)
    cacheBytes += entryBytes
    while (cacheBytes > opts.maxBytes && cache.size > 1) {
      const oldestKey = cache.keys().next().value as string
      const oldestValue = cache.get(oldestKey) ?? ''
      cache.delete(oldestKey)
      cacheBytes -= oldestKey.length + oldestValue.length
      evictions++
    }
    return value
  }

  const stats = (): SanitizeMemoStats => ({
    hits,
    misses,
    evictions,
    entries: cache.size,
    cacheBytes,
    computeMsTotal,
  })

  return { call, stats }
}
