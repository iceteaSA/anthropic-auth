# Sanitize Memo + Stream Cancel + Observability — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Memoise the repeated system-prompt sanitation, propagate consumer
cancellation to the upstream stream, and emit before/after observability — all in
the opencode plugin package.

**Architecture:** A new focused, pure module (`sanitize-memo.ts`) provides a
generic byte-bounded LRU memo. `transform.ts` wires it around the existing
sanitation function (renamed to an internal `_sanitizeSystemText`) and exposes a
stats getter. `createStrippedStream` gains a `cancel` handler. `index.ts` extends
its existing `OPENCODE_ANTHROPIC_AUTH_PERF` trace with memo deltas. No new logging
system; reuse `log()` from core (`/tmp/opencode-anthropic-auth.log`).

**Tech Stack:** TypeScript, Bun (`bun:test`), Web Streams API, existing
`@cortexkit/anthropic-auth-core` `log()`.

**Reviewers are offline** → self-review at each task: run the gate, paste output,
adversarial red-first (see the gate after every task).

---

## File Structure

- **Create** `packages/opencode/src/sanitize-memo.ts` — generic byte-bounded LRU
  memo (`makeByteBoundedMemo`) + `SanitizeMemoStats` type. Pure, no deps.
- **Create** `packages/opencode/src/tests/sanitize-memo.test.ts` — unit tests for
  the memo (hit/miss, LRU, byte-eviction, oversize, disabled, stats).
- **Modify** `packages/opencode/src/transform.ts` —
  - rename `export function sanitizeSystemText` body → internal
    `_sanitizeSystemText`
  - add memo wiring: `sanitizeSystemText` (memoised) + `getSanitizeMemoStats`
  - add `cancel` handler to `createStrippedStream` + import `log`
- **Modify** `packages/opencode/src/tests/transform.test.ts` — memoised-output
  correctness + stream-cancel propagation tests.
- **Modify** `packages/opencode/src/index.ts` —
  - import `getSanitizeMemoStats`
  - snapshot memo stats around `rewriteRequestBody`, add delta to the existing
    `rewrite_body` mark
  - add memo summary to `createPerfTrace().done`

**Env flags:** `OPENCODE_ANTHROPIC_AUTH_MEMO` (default on; `=0` baseline),
`OPENCODE_ANTHROPIC_AUTH_PERF=1` (existing; enables perf logs).

---

## Task 1: Generic byte-bounded LRU memo module

**Files:**
- Create: `packages/opencode/src/sanitize-memo.ts`
- Test: `packages/opencode/src/tests/sanitize-memo.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/opencode/src/tests/sanitize-memo.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/opencode/src/tests/sanitize-memo.test.ts`
Expected: FAIL — `Cannot find module '../sanitize-memo'`.

- [ ] **Step 3: Write the module**

`packages/opencode/src/sanitize-memo.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/opencode/src/tests/sanitize-memo.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Gate + commit**

Run: `bun run typecheck && bun test packages/opencode/src/tests/sanitize-memo.test.ts`
Expected: typecheck exit 0, tests pass.

```bash
git add packages/opencode/src/sanitize-memo.ts packages/opencode/src/tests/sanitize-memo.test.ts
git commit -m "perf(opencode): add byte-bounded LRU memo utility"
```

---

## Task 2: Memoise sanitizeSystemText

**Files:**
- Modify: `packages/opencode/src/transform.ts:323-349` (rename + wire)
- Test: `packages/opencode/src/tests/transform.test.ts` (`sanitizeSystemText` describe ~line 519)

- [ ] **Step 1: Write the failing test** (add inside the existing
  `describe('sanitizeSystemText', ...)` block in `transform.test.ts`):

```ts
  test('memoised output equals a fresh sanitation and is stable on repeat', () => {
    const text = dedent`
      You are OpenCode, an AI assistant.

      Keep this paragraph intact.
    `
    const first = sanitizeSystemText(text)
    const second = sanitizeSystemText(text)
    expect(second).toBe(first)
    // identity-bearing paragraph is still stripped (behaviour unchanged)
    expect(first).not.toContain(OPENCODE_IDENTITY_PREFIX)
  })

  test('getSanitizeMemoStats records a hit on identical repeat input', () => {
    const before = getSanitizeMemoStats()
    const text = 'unique-memo-probe-' + Date.now()
    sanitizeSystemText(text)
    sanitizeSystemText(text)
    const after = getSanitizeMemoStats()
    expect(after.hits - before.hits).toBeGreaterThanOrEqual(1)
  })
```

Add `getSanitizeMemoStats` to the import from `../transform` at the top of
`transform.test.ts`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/opencode/src/tests/transform.test.ts -t "memo"`
Expected: FAIL — `getSanitizeMemoStats` is not exported.

- [ ] **Step 3: Implement the wiring in `transform.ts`**

3a. Add `makeByteBoundedMemo` import near the top of `transform.ts` (with the
other local imports):

```ts
import { makeByteBoundedMemo } from './sanitize-memo'
```

3b. Rename the existing function at line 323 — change
`export function sanitizeSystemText(text: string): string {` to
`function _sanitizeSystemText(text: string): string {` (remove `export`, add `_`).
Leave its body untouched.

3c. Immediately AFTER that function's closing brace (currently line 349), add:

```ts
const SANITIZE_MEMO_MAX_BYTES = 8 * 1024 * 1024

/** Memo on by default; OPENCODE_ANTHROPIC_AUTH_MEMO=0 disables (baseline). */
function sanitizeMemoEnabled(): boolean {
  return process.env.OPENCODE_ANTHROPIC_AUTH_MEMO !== '0'
}

const sanitizeSystemMemo = makeByteBoundedMemo(_sanitizeSystemText, {
  maxBytes: SANITIZE_MEMO_MAX_BYTES,
  enabled: sanitizeMemoEnabled,
})

/**
 * Sanitize a system-prompt block. Memoised: the prompt is stable within a
 * session, so the paragraph-filter + regex pass is skipped on cache hits.
 */
export function sanitizeSystemText(text: string): string {
  return sanitizeSystemMemo.call(text)
}

export function getSanitizeMemoStats() {
  return sanitizeSystemMemo.stats()
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/opencode/src/tests/transform.test.ts -t "memo"`
Expected: PASS. Then full file: `bun test packages/opencode/src/tests/transform.test.ts`
Expected: all pass (existing `sanitizeSystemText` behaviour tests still green —
proves output unchanged).

- [ ] **Step 5: Gate + commit**

Run: `bun run typecheck && bun test packages/opencode/src/tests/transform.test.ts`
Expected: typecheck 0, tests pass.

```bash
git add packages/opencode/src/transform.ts packages/opencode/src/tests/transform.test.ts
git commit -m "perf(opencode): memoise system-prompt sanitation"
```

---

## Task 3: Cancel upstream stream on consumer cancel

**Files:**
- Modify: `packages/opencode/src/transform.ts:747-780` (`createStrippedStream`) +
  core `log` import
- Test: `packages/opencode/src/tests/transform.test.ts`
  (`createStrippedStream` describe ~line 444)

- [ ] **Step 1: Write the failing test** (add inside the existing
  `describe('createStrippedStream', ...)` block):

```ts
  test('cancels the upstream reader when the consumer cancels', async () => {
    let upstreamCancelled = false
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: ping\n\n'))
      },
      cancel() {
        upstreamCancelled = true
      },
    })
    const stripped = createStrippedStream(
      new Response(upstream, { status: 200 }),
    )
    const reader = stripped.body!.getReader()
    await reader.read()
    await reader.cancel('consumer-abort')
    expect(upstreamCancelled).toBe(true)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/opencode/src/tests/transform.test.ts -t "cancels the upstream"`
Expected: FAIL — `upstreamCancelled` is `false` (no cancel handler today).

- [ ] **Step 3: Implement the cancel handler**

3a. Add `log` to the existing core import block at the top of `transform.ts`
(the `import { … } from '@cortexkit/anthropic-auth-core'` block, lines ~1-20) —
add `log,` to the imported symbols.

3b. In `createStrippedStream`, change the `new ReadableStream({ async pull… })`
to add a `cancel` method (leave `pull` exactly as-is):

```ts
  const stream = new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read()
      if (done) {
        const flushed = splitToolPrefixRewriteBuffer(
          `${pending}${decoder.decode()}`,
          true,
        )
        if (flushed.ready) controller.enqueue(encoder.encode(flushed.ready))
        controller.close()
        return
      }

      const text = pending + decoder.decode(value, { stream: true })
      const rewritten = splitToolPrefixRewriteBuffer(text)
      pending = rewritten.pending
      if (rewritten.ready) controller.enqueue(encoder.encode(rewritten.ready))
    },
    cancel(reason) {
      if (process.env.OPENCODE_ANTHROPIC_AUTH_PERF === '1') {
        log('[perf] opencode stream_cancel', { reason: String(reason ?? '') })
      }
      void reader.cancel(reason)
    },
  })
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/opencode/src/tests/transform.test.ts -t "cancels the upstream"`
Expected: PASS. Then full file green.

- [ ] **Step 5: Gate + commit**

Run: `bun run typecheck && bun test packages/opencode/src/tests/transform.test.ts`
Expected: typecheck 0, tests pass.

```bash
git add packages/opencode/src/transform.ts packages/opencode/src/tests/transform.test.ts
git commit -m "perf(opencode): cancel upstream stream on consumer cancel"
```

---

## Task 4: Observability wiring in index.ts

**Files:**
- Modify: `packages/opencode/src/index.ts` (transform import block ~line 85;
  `rewrite_body` mark ~1539-1563; `createPerfTrace().done` ~196-205)

> Note: this task is observational glue verified by typecheck/build + the live
> before/after capture (Task 6), not a unit test — the fork has no isolated
> request harness for the rewrite path. The underlying data source
> (`getSanitizeMemoStats` deltas) is already unit-tested in Task 2.

- [ ] **Step 1: Import the stats getter**

In `index.ts`, add `getSanitizeMemoStats` to the existing import from
`./transform` (the block that imports `rewriteRequestBody, createStrippedStream`,
around line 85-88).

- [ ] **Step 2: Snapshot around `rewriteRequestBody` and extend the mark**

At `index.ts:1539`, immediately BEFORE `body = await rewriteRequestBody(body, {`,
add:

```ts
              const memoBefore = getSanitizeMemoStats()
```

After the `rewriteRequestBody` call returns (after the closing `})` at line 1544),
add:

```ts
              const memoAfter = getSanitizeMemoStats()
```

Then in the existing `trace?.mark('rewrite_body', { … })` object (line 1554-1563),
add these three fields:

```ts
                sanitizeHits: memoAfter.hits - memoBefore.hits,
                sanitizeMisses: memoAfter.misses - memoBefore.misses,
                sanitizeComputeMs: roundMs(
                  memoAfter.computeMsTotal - memoBefore.computeMsTotal,
                ),
```

- [ ] **Step 3: Add memo summary to the trace `done` log**

In `createPerfTrace`, inside `done(stage, stageData)`'s
`if (perfLoggingEnabled()) {` block, before the `log('[perf] opencode request
done', {` call, compute the summary and add three fields to the logged object:

```ts
        const memo = getSanitizeMemoStats()
        const memoTotal = memo.hits + memo.misses
        log('[perf] opencode request done', {
          requestId: trace.requestId,
          stage,
          deltaMs: roundMs(current - trace.last),
          totalMs: roundMs(current - trace.start),
          memoHitRate:
            memoTotal > 0 ? Math.round((memo.hits / memoTotal) * 100) / 100 : 0,
          memoEntries: memo.entries,
          memoCacheBytes: memo.cacheBytes,
          ...stageData,
        })
```

- [ ] **Step 4: Gate (typecheck + build + full suite)**

Run: `bun run typecheck && bun run build && bun test`
Expected: typecheck 0, build 0, full suite green (≥ the 397-test baseline, no
regressions).

- [ ] **Step 5: Commit**

```bash
git add packages/opencode/src/index.ts
git commit -m "perf(opencode): trace sanitize memo hit/miss + compute time"
```

---

## Task 5: Self-review (reviewers offline)

- [ ] Re-read the full diff: `git --no-pager diff upstream/main..HEAD`.
- [ ] Adversarial checks:
  - Memo output is byte-identical to pre-change (exact-string keys, pure fn) —
    confirmed by the unchanged `sanitizeSystemText` behaviour tests passing.
  - Billing header is NOT cached (added via `unshift` after
    `prependClaudeCodeIdentity`) — confirm no code path memoises post-billing text.
  - `cancel` always calls `reader.cancel` even when perf logging is off.
  - Disabled-memo path still produces correct output (Task 1 test).
- [ ] Re-run the gate and PASTE output: `bun run typecheck && bun run build && bun test`.
- [ ] If any issue: fix → re-run gate → repeat (max 2 iterations, then escalate).

---

## Task 6: Capture before/after numbers (this session)

- [ ] Build the plugin: `bun run build` (already part of Task 4 gate).
- [ ] Restart opencode with baseline (memo OFF) + perf on, exercise a
  representative prompt, then grep the plugin log:

```bash
# memo OFF (baseline)
OPENCODE_ANTHROPIC_AUTH_PERF=1 OPENCODE_ANTHROPIC_AUTH_MEMO=0 <run opencode session>
grep '"stage":"rewrite_body"' /tmp/opencode-anthropic-auth.log | tail -20
# record sanitizeComputeMs / sanitizeMisses
```

- [ ] Repeat with memo ON (default):

```bash
OPENCODE_ANTHROPIC_AUTH_PERF=1 <run opencode session>   # MEMO defaults on
grep '"stage":"rewrite_body"' /tmp/opencode-anthropic-auth.log | tail -20
grep '"stage":".*","memoHitRate"' /tmp/opencode-anthropic-auth.log | tail -5
# expect sanitizeComputeMs -> ~0 after warm-up, memoHitRate high
```

- [ ] Compare distributions. **Decision gate:** if memo-on `sanitizeComputeMs`
  is not materially lower (and hit rate not high), STOP — investigate prompt
  stability (`sanitizeMisses` staying high ⇒ prompt changes per request) before
  shipping. Do not ship a no-op.

---

## Task 7: Deliver PR off upstream/main

> Branch creation / push / PR are main-agent (human-directed) git ops.

- [ ] Confirm the implementation commits sit cleanly on `upstream/main`:
  `git --no-pager log --oneline upstream/main..HEAD` shows only Tasks 1-4
  commits, no `dev`/spec/plan files.
- [ ] (The spec + plan docs live on `dev`/local only — never added to the PR
  branch commits.)
- [ ] Push branch `perf/sanitize-memo-stream-cancel` to `origin`.
- [ ] `gh pr create --repo cortexkit/anthropic-auth --base main --head iceteaSA:perf/sanitize-memo-stream-cancel`
  with a description summarising the memo, the cancel fix, the observability, and
  the measured before/after numbers from Task 6.

---

## Self-Review (plan vs spec)

- **Spec coverage:** memo (Tasks 1-2), stream cancel (Task 3), observability
  (Task 4 + done summary), out-of-scope items excluded, tests (Tasks 1-3),
  before/after method (Task 6), self-review since reviewers offline (Task 5),
  delivery off upstream/main (Task 7). All covered.
- **Type consistency:** `makeByteBoundedMemo` / `SanitizeMemoStats` /
  `getSanitizeMemoStats` / `sanitizeSystemText` / `_sanitizeSystemText` names are
  consistent across Tasks 1-4. `call`/`stats` shape matches usage.
- **No placeholders:** every code step has full code; commands have expected
  output.
