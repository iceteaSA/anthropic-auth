# Perf baseline — memo OFF (OPENCODE_ANTHROPIC_AUTH_MEMO=0)

- Date: 2026-06-09
- Build: dev (v1.7.0 + relay/killswitch + perf commits), memo DISABLED for baseline
- Source log: /tmp/opencode-anthropic-auth.log
- Requests captured: 21

All times in ms. `rewriteMs` = local rewriteRequestBody (parse+sanitize+cache+sign).
`sanitizeComputeMs` = sanitation only. `ttfbMs` = send_headers_received (upstream Anthropic TTFB).
Cache token columns are blank for this baseline (instrumentation added after capture).

| req | payload | rewriteMs | sanitizeMisses | sanitizeComputeMs | ttfbMs (upstream) | cacheRead | cacheCreate |
|-----|---------|-----------|----------------|-------------------|-------------------|-----------|-------------|
| 1 | 803KB | 6.3 | 2 | 0.3 | 5190 |  |  |
| 2 | 811KB | 3.7 | 2 | 0.1 | 2364.7 |  |  |
| 3 | 820KB | 3.8 | 2 | 0.1 | 1922 |  |  |
| 4 | 830KB | 3.6 | 2 | 0.1 | 1754.3 |  |  |
| 5 | 844KB | 4.4 | 2 | 0.1 | 4772.2 |  |  |
| 6 | 848KB | 4.9 | 2 | 0.1 | 1707.1 |  |  |
| 7 | 849KB | 4 | 2 | 0.1 | 1883.2 |  |  |
| 8 | 849KB | 3.2 | 2 | 0.1 | 1697.5 |  |  |
| 9 | 855KB | 4 | 2 | 0.1 | 1699.2 |  |  |
| 10 | 864KB | 3.9 | 2 | 0.1 | 2459 |  |  |
| 11 | 875KB | 3.7 | 2 | 0.1 | 2166.2 |  |  |
| 12 | 892KB | 3.9 | 2 | 0.1 | 2645.3 |  |  |
| 13 | 895KB | 3.8 | 2 | 0.1 | 1857.1 |  |  |
| 14 | 896KB | 3.7 | 2 | 0.1 | 10252.6 |  |  |
| 15 | 898KB | 4.2 | 2 | 0.1 | 1820.3 |  |  |
| 16 | 899KB | 3.5 | 2 | 0.1 | 1807.9 |  |  |
| 17 | 900KB | 3.6 | 2 | 0.1 | 2232.7 |  |  |
| 18 | 903KB | 5.1 | 2 | 0.2 | 2449.5 |  |  |
| 19 | 920KB | 4.2 | 2 | 0.1 | 2470.2 |  |  |
| 20 | 935KB | 4.5 | 2 | 0.2 | 2323.2 |  |  |
| 21 | 942KB | 4.8 | 2 | 0.1 |  |  |  |

## Summary (baseline, memo off)

- Requests: 21
- sanitizeComputeMs: avg 0.12, max 0.3, sum 2.5
- Upstream TTFB (send_headers_received): avg 2773.71ms, min 1697.5ms, max 10252.6ms
- Finding: local sanitation is ~0.12ms/req; upstream TTFB dominates at ~2774ms/req (23299x larger).

## Next cycle (to compare)

Restart opencode with memo ON + perf on (and the cache-token build):
```
OPENCODE_ANTHROPIC_AUTH_PERF=1    # do NOT set OPENCODE_ANTHROPIC_AUTH_MEMO (defaults on)
```
Expect: sanitizeHits>0, sanitizeComputeMs→~0, and now cacheRead/cacheCreate populated so
TTFB can be correlated with prompt-cache hits/misses.
