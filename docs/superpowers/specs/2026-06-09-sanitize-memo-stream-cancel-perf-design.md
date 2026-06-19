# Perf: memoise system-prompt sanitation + cancel upstream stream + observability

- **Date:** 2026-06-09
- **Status:** Approved design, pending spec review
- **Target:** new PR off `cortexkit/anthropic-auth` `main` (v1.7.0, `9b21b61`)
- **Branch:** `perf/sanitize-memo-stream-cancel`
- **Source of ideas:** local `closedfist-antrhopic-auth` perf work (adapted, not copied — different architecture)

## 1. Problem

The plugin gets slow on large payloads. Two concrete causes:

1. **Re-sanitising a stable system prompt every request.** `rewriteRequestBody`
   (`packages/opencode/src/transform.ts`) calls `prependClaudeCodeIdentity` →
   `sanitizeSystemText` on every request. `sanitizeSystemText` does a paragraph
   split, a removal-anchor filter, and a loop of `TEXT_REPLACEMENTS` regex
   `.replace()` over the **entire system prompt**. The system prompt is stable
   within a session (env/cwd/date change at most daily), so this full pass is
   redundant work on every call. Sessions can carry up to ~3 MB of payload.

2. **Leaked upstream on consumer cancel.** `createStrippedStream` wraps the
   upstream SSE in a Web `ReadableStream` whose `pull` reads
   `response.body.getReader()`, but defines **no `cancel()` handler**. When the
   consumer aborts (user stops a generation), the upstream reader is never
   cancelled — the upstream connection/body is not released.

We must also be able to **prove** the change helps with before/after numbers,
not assume it.

## 2. Goals / Non-goals

**Goals**
- Eliminate redundant system-prompt sanitation via a memory-bounded cache.
- Propagate consumer cancellation to the upstream reader.
- Emit greppable before/after observability, toggleable for A/B measurement,
  reusing the existing `OPENCODE_ANTHROPIC_AUTH_PERF` infra.

**Non-goals (explicitly out of scope)**
- tool-json unsafe-integer fast-path — our fork has **no** unsafe-integer
  subsystem; there is nothing to fast-path. Porting it would mean importing a
  whole subsystem, not a perf tweak.
- reverse tool-arg recursive walk — our fork uses tool-name **prefixing**
  (`prefixToolNames`/`stripToolPrefix`), not substitution reversal. No target.
- proactive-refresh tick guard — unrelated to payload slowness.

## 3. Design

All code in `packages/opencode/src/transform.ts` unless noted.

### 3.1 Bounded LRU memo (byte-budget)

A small, generic, byte-bounded LRU wrapping a string→string function.

```
makeByteBoundedMemo(fn: (key: string) => string, opts: {
  maxBytes: number          // budget; evict LRU until total <= budget
  enabled: () => boolean     // runtime toggle (env)
}): {
  call: (key: string) => string
  stats: () => { hits; misses; evictions; entries; cacheBytes; computeMsTotal }
}
```

Behaviour:
- Backing store `Map<string,string>` (insertion-ordered).
- **Hit:** `delete` + re-`set` to move-to-end (true LRU recency); `hits++`.
- **Miss:** time `fn(key)` with `performance.now()`, add `computeMsTotal +=
  duration`, `misses++`, insert.
- **Byte accounting:** `entryBytes ≈ key.length + value.length` (UTF-16 length
  proxy — cheap, monotonic, good enough for a budget). Maintain running
  `cacheBytes`.
- **Eviction:** after insert, while `cacheBytes > maxBytes` and `entries > 1`,
  evict oldest (first map key), decrementing `cacheBytes`; `evictions++`.
- **Oversize guard:** if a single `entryBytes > maxBytes`, compute and return but
  **do not cache** (prevents insert-then-immediately-evict thrash). Counts as a
  miss.
- **Disabled path:** when `enabled()` is false, bypass the cache entirely — call
  `fn` directly and still accumulate `misses`/`computeMsTotal` (so the disabled
  run is the measurable baseline).

**Budget:** `SANITIZE_MEMO_MAX_BYTES = 8 * 1024 * 1024` (8 MB) module constant.
Rationale: a stable ~3 MB prompt = key+value ≈ 6 MB ≤ budget → resident as 1
entry; many small prompts → dozens of entries; hard cap 8 MB regardless of
session size.

**Integration:** rename the current `sanitizeSystemText` body to an internal
`_sanitizeSystemText`; export `sanitizeSystemText` as the memoised `call`. The
exported signature is unchanged, so `prependClaudeCodeIdentity` and all callers
are untouched.

**Correctness/safety:**
- `TEXT_REPLACEMENTS`, `PARAGRAPH_REMOVAL_ANCHORS`, `OPENCODE_IDENTITY_PREFIX`
  are **static module constants** → `_sanitizeSystemText` is pure → memo output
  is identical to the direct call for the process lifetime.
- No hashing — exact string keys → zero collision risk → output is byte-identical
  to today.
- The dynamic billing header is `unshift`-ed onto `parsed.system` **after**
  `prependClaudeCodeIdentity`, so it never enters the cache.

**Toggle:** `OPENCODE_ANTHROPIC_AUTH_MEMO` — default on; `=0` disables (baseline).

### 3.2 Stream cancel → abort upstream

In `createStrippedStream`, add a `cancel` handler to the underlying source:

```
const stream = new ReadableStream({
  async pull(controller) { /* unchanged */ },
  cancel(reason) { reader.cancel(reason).catch(() => {}) },
})
```

This is the idiomatic Web Streams equivalent of closedfist's
`onCancel → producerAbort.abort()`. Bounded-queue is already satisfied: the
stream is pull-based, so the runtime only calls `pull` under consumer demand
(inherent backpressure) — nothing to add.

### 3.3 Observability (before/after)

Reuse the existing `PerfTrace` / `OPENCODE_ANTHROPIC_AUTH_PERF=1` infra in
`index.ts`. No new logging system.

1. **Memo stats export** (`transform.ts`): export
   `getSanitizeMemoStats()` returning the cumulative `stats()` snapshot
   (`hits, misses, evictions, entries, cacheBytes, computeMsTotal`).

2. **Per-request delta on the existing `rewrite_body` mark** (`index.ts:1554`):
   snapshot `getSanitizeMemoStats()` immediately before `rewriteRequestBody`
   (`:1539`) and after; add the delta to the existing mark data:
   `{ sanitizeHits, sanitizeMisses, sanitizeComputeMs }`.
   - Baseline run (memo off): `sanitizeMisses>0`, `sanitizeComputeMs` = full
     sanitation cost per request.
   - After run (memo on, warm): `sanitizeHits>0`, `sanitizeMisses≈0`,
     `sanitizeComputeMs≈0`. The delta between runs is the honest saving — no
     fabricated "ms saved" counter.

   - *Caveat:* the snapshot is a global cumulative counter, so concurrent
     in-flight requests can cross-attribute misses to a request's delta. This is
     acceptable — we compare **aggregate distributions** across the A/B runs, not
     exact per-request values.

3. **Cumulative summary on `done`:** include
   `{ memoHitRate, memoEntries, memoCacheBytes }` so a single `[perf] … request
   done` line shows steady-state cache effectiveness.

4. **Stream cancel log:** in `createStrippedStream` `cancel`, when perf logging is
   enabled emit one `[perf] opencode stream_cancel { reason }` line so aborts are
   observable.

**Measurement methodology (run in this opencode session):**
1. `OPENCODE_ANTHROPIC_AUTH_PERF=1 OPENCODE_ANTHROPIC_AUTH_MEMO=0` → exercise a
   representative session → grep the plugin log
   `/tmp/opencode-anthropic-auth.log` (= `getLogFilePath()`,
   `os.tmpdir()/opencode-anthropic-auth.log`) for `[perf] opencode request
   stage` lines with `stage:"rewrite_body"` → record `sanitizeComputeMs`
   distribution (baseline). Note: `log()` is a no-op under `NODE_ENV=test`.
2. Same workload with `OPENCODE_ANTHROPIC_AUTH_MEMO=1` (default) → record again.
3. Compare `sanitizeComputeMs` (per request) and `event_loop_lag` occurrences.
   Expect computeMs → ~0 after warm-up; hitRate high.

## 4. Testing

Unit (`packages/opencode/src/tests/transform.test.ts`):
- Memo correctness: memoised output === direct `_sanitizeSystemText` output for
  varied inputs (including identity-prefix and removal-anchor cases).
- Hit avoids recompute: spy/counter shows the underlying fn runs once for
  repeated identical input; `stats().hits` increments.
- Byte-budget eviction: with a tiny injected `maxBytes`, inserting distinct
  large inputs evicts oldest; `cacheBytes <= maxBytes`; `entries` bounded.
- Oversize guard: input larger than budget is returned correctly and not cached.
- Disabled toggle: with memo disabled, output still correct and `misses`
  accumulate (baseline path).
- Stream cancel: `createStrippedStream` `cancel()` calls the upstream
  `reader.cancel()` (mock reader records the call).

Gates: `bun run typecheck` (0), `bun run build` (0), `bun test` (all green,
no regression vs the 397-test baseline).

## 5. Delivery & review

- Branch `perf/sanitize-memo-stream-cancel` off `upstream/main` — **clean**, no
  `dev` contamination (`git log --oneline upstream/main..HEAD` shows only these
  commits). This spec doc stays on `dev`/local, **not** on the PR branch.
- **Reviewer subagents are offline** → self-review at the icetea-loop review
  step: run all gates locally and paste the output; adversarial red-first pass
  (drive a failing test before accepting each behaviour; evidence over
  assertion). Fix → re-verify before claiming done.
- PR to `cortexkit/anthropic-auth:main` once gates are green and before/after
  numbers confirm a real improvement. If numbers show no improvement, stop and
  reassess — do not ship a no-op.

## 6. Risks / assumptions

- **Assumption:** opencode's system prompt is session-stable. Validate cheaply by
  inspecting `sanitizeMisses` per request in the warm A/B run — if misses stay
  high, the prompt is changing per request and memoisation won't help (reassess).
- **Memory:** capped at 8 MB by construction; UTF-16 length proxy slightly
  under-counts multi-byte chars but is monotonic and safe for a budget.
- **No correctness drift:** exact-string keys, pure function, identical output;
  billing header excluded from cache.
