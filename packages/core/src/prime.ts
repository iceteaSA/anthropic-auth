import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type AccountQuotaWindow,
  type AccountStorage,
  type FallbackAccount,
  isOAuthAccount,
  isPermanentRefreshError,
  killswitchPassesPolicy,
  type OAuthQuotaSnapshot,
  type PrimeUsageCounters,
} from './accounts.ts'
// Logger import is via the public package alias so the singleton instance
// shared by downstream tests (which load through the dist main entry) is the
// same object this module writes to. Importing from './logger.ts' directly
// would yield a distinct module instance under Bun's workspace + symlink
// resolution and silently swallow sink captures from cross-package tests.
import { logger } from './logger.ts'
import {
  CLAUDE_HAIKU_4_5_MODEL_ID,
  CLAUDE_HAIKU_4_5_PRICING,
} from './models.ts'

// Re-export pricing for downstream packages that import it through core's
// public surface (the test suite verifies exact per-million-token values).
export { CLAUDE_HAIKU_4_5_PRICING }

/**
 * `/claude-prime` — opt-in 5h quota window priming. Default OFF.
 *
 * Every OAuth account (main + enabled fallbacks) gets one minimal request
 * fired ~60s after its `five_hour.resetsAt`, exactly once across concurrent
 * OpenCode processes. Catch-up on boot; redundancy guard via fresh quota
 * check; cross-process atomic marker claim via `writeFile(..., flag: 'wx')`.
 */

export const CLAUDE_PRIME_COMMAND_NAME = 'claude-prime'

export const PRIME_TICK_MS = 60_000
export const PRIME_DUE_OFFSET_MS = 60_000
export const PRIME_MARKER_MAX_AGE_MS = 6 * 60 * 60_000

export type PrimeCommandAction =
  | { type: 'status' }
  | { type: 'enable' }
  | { type: 'disable' }
  | { type: 'usage' }

export type PrimeAccountStatus = {
  id: string
  label: string
  nextDueAt?: number | null
  lastPrimedAt?: number | null
  lastResult?: 'ok' | 'error'
  usage?: import('./accounts.ts').PrimeUsageCounters
  estimatedCostUsd?: number
}

export type PrimeSendResult =
  | {
      ok: true
      status: number
      ms: number
      usage?: { inputTokens?: number; outputTokens?: number }
    }
  | { ok: false; status?: number; ms?: number; error: string }

/**
 * Pure command parser — accepts `''` / `on` / `off` and treats anything else
 * as a usage error. Mirrors `parseFastModeCommandAction` shape so all
 * `claude-*` commands stay uniform.
 */
export function parsePrimeCommandAction(input: string): PrimeCommandAction {
  const normalized = input.trim().split(/\s+/).filter(Boolean)
  if (normalized.length === 0) return { type: 'status' }
  if (normalized.length === 1 && normalized[0] === 'on')
    return { type: 'enable' }
  if (normalized.length === 1 && normalized[0] === 'off')
    return { type: 'disable' }
  return { type: 'usage' }
}

/**
 * Per-million-token USD cost projection. Locale-independent math; the display
 * layer is responsible for formatting. Returns 0 for absent counters so
 * pre-fire accounts still get a clean number in the sidebar/dialog.
 */
export function estimatePrimeCostUsd(
  usage?: import('./accounts.ts').PrimeUsageCounters,
): number {
  if (!usage) return 0
  return (
    (usage.inputTokens * CLAUDE_HAIKU_4_5_PRICING.input +
      usage.outputTokens * CLAUDE_HAIKU_4_5_PRICING.output) /
    1_000_000
  )
}

function accountLabel(
  id: string,
  storage: AccountStorage | null,
  fallbackAccount?: { label?: string },
): string {
  if (fallbackAccount?.label?.trim()) return fallbackAccount.label
  if (id === 'main') return 'main'
  // Stale-storage fallback: the caller passed a non-empty storage so prefer
  // the first matching account label.
  const found = storage?.accounts?.find((a) => a.id === id)
  if (found?.label?.trim()) return found.label
  return id
}

/**
 * Project per-account prime status. Enumerates a synthetic `main` plus each
 * enabled OAuth fallback. `nextDueAt` is the stored five-hour reset plus
 * `PRIME_DUE_OFFSET_MS`; null when no reset is known. Manager-transient
 * `lastPrimedAt`/`lastResult` overlay the persisted counters so the dialog and
 * sidebar can show "just attempted" without waiting for the next save.
 */
export function buildPrimeAccountStatuses(
  storage: AccountStorage | null,
  options?: {
    now?: number
    transient?: ReadonlyMap<
      string,
      { lastPrimedAt?: number; lastResult?: 'ok' | 'error' }
    >
  },
): PrimeAccountStatus[] {
  const transient = options?.transient
  const mainStoredQuota = storage?.quota?.mainQuota
  const mainUsage = storage?.prime?.main
  const mainStatus: PrimeAccountStatus = {
    id: 'main',
    label: 'main',
    nextDueAt: primeNextDueAt(mainStoredQuota?.five_hour),
    lastPrimedAt: transient?.get('main')?.lastPrimedAt ?? null,
    lastResult: transient?.get('main')?.lastResult,
    usage: mainUsage,
    estimatedCostUsd: estimatePrimeCostUsd(mainUsage),
  }

  const fallbacks: PrimeAccountStatus[] = (storage?.accounts ?? [])
    .filter(isOAuthAccount)
    .filter((account) => account.enabled !== false)
    .map((account) => ({
      id: account.id,
      label: accountLabel(account.id, storage, account),
      nextDueAt: primeNextDueAt(account.quota?.five_hour),
      lastPrimedAt: transient?.get(account.id)?.lastPrimedAt ?? null,
      lastResult: transient?.get(account.id)?.lastResult,
      usage: account.prime,
      estimatedCostUsd: estimatePrimeCostUsd(account.prime),
    }))

  return [mainStatus, ...fallbacks]
}

function primeNextDueAt(
  window?: AccountQuotaWindow,
): number | null | undefined {
  if (!window?.resetsAt) return null
  const ms = Date.parse(window.resetsAt)
  if (!Number.isFinite(ms)) return null
  return ms + PRIME_DUE_OFFSET_MS
}

/**
 * Pure multi-line status summary shared by the OpenCode dialog, the sidebar
 * expanded row, and the Pi display. Title is stable text the dialog uses to
 * anchor and the orchestrator uses to assert RED.
 */
export function buildPrimeStatusSummary(input: {
  enabled: boolean
  accounts: PrimeAccountStatus[]
}): string {
  const header = input.enabled
    ? '## Claude Prime Status'
    : '## Claude Prime Disabled'
  const lines: string[] = [header, '']
  lines.push(`Status: ${input.enabled ? 'enabled' : 'disabled'}`)
  lines.push('')
  lines.push('Accounts:')
  for (const account of input.accounts) {
    const usage = account.usage
    const count = usage?.count ?? 0
    const due = formatDue(account.nextDueAt)
    const primed = formatPrimed(account.lastPrimedAt, account.lastResult)
    const segments: string[] = [`${account.label}`]
    if (due) segments.push(`next prime ${due}`)
    if (primed) segments.push(primed)
    if (count > 0) {
      segments.push(
        `${count} ${count === 1 ? 'prime' : 'primes'} \u2248 $${formatUsd(
          account.estimatedCostUsd ?? 0,
        )}`,
      )
    }
    lines.push(`- ${segments.join(' · ')}`)
  }
  lines.push('')
  lines.push('Usage: `/claude-prime on`, `/claude-prime off`, or status.')
  return lines.join('\n')
}

function formatDue(nextDueAt: number | null | undefined): string {
  if (typeof nextDueAt !== 'number') return ''
  return new Date(nextDueAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatPrimed(
  lastPrimedAt: number | null | undefined,
  lastResult: 'ok' | 'error' | undefined,
): string {
  if (typeof lastPrimedAt !== 'number') return ''
  const time = new Date(lastPrimedAt).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  })
  if (lastResult === 'error') return `primed ${time} err`
  return `primed ${time} \u2713`
}

function formatUsd(value: number): string {
  if (value === 0) return '0'
  if (value < 0.0001) return value.toExponential(2)
  return value.toFixed(Math.min(6, Math.max(0, 4)))
}

/**
 * Pure executor — returns markdown text and an optional `updated` envelope.
 * Effects (persistent toggle, manager start/stop) are the caller's job; Pi
 * uses this same function in display-only mode.
 */
export function executePrimeCommand(input: {
  argumentsText: string
  enabled: boolean
  accounts: PrimeAccountStatus[]
}): { text: string; updated?: { enabled: boolean } } {
  const action = parsePrimeCommandAction(input.argumentsText)

  if (action.type === 'status') {
    return {
      text: buildPrimeStatusSummary({
        enabled: input.enabled,
        accounts: input.accounts,
      }),
    }
  }

  if (action.type === 'enable') {
    return {
      text: buildPrimeStatusSummary({
        enabled: true,
        accounts: input.accounts,
      }),
      updated: { enabled: true },
    }
  }

  if (action.type === 'disable') {
    return {
      text: buildPrimeStatusSummary({
        enabled: false,
        accounts: input.accounts,
      }),
      updated: { enabled: false },
    }
  }

  return {
    text: [
      '## Claude Prime Usage',
      '',
      'Usage: `/claude-prime`, `/claude-prime on`, or `/claude-prime off`.',
      '',
      buildPrimeStatusSummary({
        enabled: input.enabled,
        accounts: input.accounts,
      }),
    ].join('\n'),
  }
}

/**
 * Eligibility check shared by the manager tick and the dialog preview. Returns
 * false when the account is a non-OAuth API-key account, explicitly disabled,
 * has a permanent refresh error, or fails the killswitch policy (without a
 * modelId — a killed account is blocked from spending at all).
 */
export function primeIsEligible(input: {
  storage: AccountStorage | null
  accountId: 'main' | string
  isOAuth: boolean
  isEnabled: boolean
  hasPermanentRefreshError: boolean
  quota?: OAuthQuotaSnapshot
}): boolean {
  if (!input.isOAuth) return false
  if (!input.isEnabled) return false
  if (input.hasPermanentRefreshError) return false
  if (!killswitchPassesPolicy(input.quota, input.storage, input.accountId)) {
    return false
  }
  return true
}

export const PRIME_REQUEST_BODY = {
  model: CLAUDE_HAIKU_4_5_MODEL_ID,
  max_tokens: 1,
  system: 'Reply with 1 when you receive 0.',
  messages: [{ role: 'user', content: '0' }],
} as const

export function buildPrimeRequestBody(): {
  model: string
  max_tokens: number
  system: string
  messages: Array<{ role: 'user'; content: string }>
} {
  // Copy to keep callers from accidentally mutating the canonical frozen body.
  return JSON.parse(JSON.stringify(PRIME_REQUEST_BODY))
}

// -- PrimeManager -----------------------------------------------------------

type AccountEvaluation = {
  id: 'main' | string
  label: string
  isOAuth: boolean
  isEnabled: boolean
  hasPermanentRefreshError: boolean
  storedQuota?: OAuthQuotaSnapshot
  storedFiveHour?: AccountQuotaWindow
}

function defaultMarkerDir(): string {
  return join(tmpdir(), 'opencode-anthropic-auth', 'prime')
}

function primeAccountLabel(
  id: 'main' | string,
  fallback?: FallbackAccount,
): string {
  if (id === 'main') return 'main'
  if (fallback && 'label' in fallback && fallback.label?.trim()) {
    return fallback.label
  }
  return id
}

function evaluateAccounts(storage: AccountStorage): AccountEvaluation[] {
  const evaluations: AccountEvaluation[] = []
  evaluations.push({
    id: 'main',
    label: 'main',
    isOAuth: true,
    isEnabled: true,
    hasPermanentRefreshError: isPermanentRefreshError(
      storage.refresh?.mainLastRefreshError,
    ),
    storedQuota: storage.quota?.mainQuota,
    storedFiveHour: storage.quota?.mainQuota?.five_hour,
  })
  for (const account of storage.accounts ?? []) {
    if (!isOAuthAccount(account)) continue
    if (account.enabled === false) continue
    evaluations.push({
      id: account.id,
      label: primeAccountLabel(account.id, account),
      isOAuth: true,
      isEnabled: true,
      hasPermanentRefreshError: isPermanentRefreshError(
        account.lastRefreshError,
      ),
      storedQuota: account.quota,
      storedFiveHour: account.quota?.five_hour,
    })
  }
  return evaluations
}

function storedResetMs(window?: AccountQuotaWindow): number | undefined {
  if (!window?.resetsAt) return undefined
  const ms = Date.parse(window.resetsAt)
  return Number.isFinite(ms) ? ms : undefined
}

/**
 * Scheduler for `/claude-prime`. Mirrors `CacheKeepManager` lifecycle (unref'd
 * 60s interval, idempotent start/stop, swallowed tick errors) but adds the
 * cross-process atomic marker claim before firing — exactly one OpenCode
 * process fires per reset epoch even with N concurrent instances.
 *
 * Dependencies are injected so the manager can be exercised deterministically
 * without filesystem, network, or live OAuth state.
 */
export class PrimeManager {
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly options: {
    loadStorage: () => Promise<AccountStorage | null>
    refreshQuota: (accountId: 'main' | string) => Promise<OAuthQuotaSnapshot>
    sendPrime: (accountId: 'main' | string) => Promise<PrimeSendResult>
    recordSuccess: (
      accountId: 'main' | string,
      usage: { inputTokens?: number; outputTokens?: number },
    ) => Promise<PrimeUsageCounters>
    now?: () => number
    markerDir?: string
  }
  // Per-account transient state from the last attempt — overlays persisted
  // counters in `stats()` so the sidebar/dialog can show "just attempted"
  // without waiting for the next save. NOT persisted.
  private transient = new Map<
    string,
    { lastPrimedAt: number; lastResult: 'ok' | 'error' }
  >()
  // Latest cumulative counters returned by recordSuccess. Overlays the
  // persisted counters in stats() before the next load persists them.
  private counters = new Map<'main' | string, PrimeUsageCounters>()

  constructor(options: {
    loadStorage: () => Promise<AccountStorage | null>
    refreshQuota: (accountId: 'main' | string) => Promise<OAuthQuotaSnapshot>
    sendPrime: (accountId: 'main' | string) => Promise<PrimeSendResult>
    recordSuccess: (
      accountId: 'main' | string,
      usage: { inputTokens?: number; outputTokens?: number },
    ) => Promise<PrimeUsageCounters>
    now?: () => number
    markerDir?: string
  }) {
    this.options = options
  }

  start(): void {
    if (this.timer) return
    logger.trace('prime', 'manager started')
    this.timer = setInterval(() => {
      void this.tick().catch((error) => {
        logger.warn('prime', 'tick failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }, PRIME_TICK_MS)
    if (typeof this.timer === 'object' && 'unref' in this.timer) {
      ;(this.timer as { unref?: () => void }).unref?.()
    }
  }

  stop(): void {
    if (!this.timer) return
    logger.trace('prime', 'manager stopped')
    clearInterval(this.timer)
    this.timer = null
  }

  async tick(): Promise<void> {
    const now = this.options.now?.() ?? Date.now()
    logger.trace('prime', 'tick start', { now })
    await this.sweepMarkers(now)
    const storage = await this.options.loadStorage()
    if (!storage) {
      logger.trace('prime', 'tick: no storage, skipping')
      return
    }
    const evaluations = evaluateAccounts(storage)
    await Promise.all(
      evaluations.map((evaluation) =>
        this.runForAccount(evaluation, storage, now),
      ),
    )
    logger.trace('prime', 'tick end')
  }

  /**
   * Project cumulative per-account status for the sidebar and dialog. Machine
   * values only — formatting belongs in the TUI/sidebar/Pi layer.
   */
  stats(
    storage?: AccountStorage | null,
    nowArg?: number,
  ): PrimeAccountStatus[] {
    const baseStatuses = buildPrimeAccountStatuses(storage ?? null, {
      now: nowArg,
      transient: this.transient,
    })
    if (this.counters.size === 0) return baseStatuses
    return baseStatuses.map((status) => {
      const overlay = this.counters.get(status.id)
      if (!overlay) return status
      return {
        ...status,
        usage: overlay,
        estimatedCostUsd: estimatePrimeCostUsd(overlay),
      }
    })
  }

  private async runForAccount(
    evaluation: AccountEvaluation,
    storage: AccountStorage,
    now: number,
  ): Promise<void> {
    try {
      if (
        !primeIsEligible({
          storage,
          accountId: evaluation.id,
          isOAuth: evaluation.isOAuth,
          isEnabled: evaluation.isEnabled,
          hasPermanentRefreshError: evaluation.hasPermanentRefreshError,
          quota: evaluation.storedQuota,
        })
      ) {
        logger.trace('prime', 'ineligible', { account: evaluation.id })
        return
      }

      const storedResetEpoch = storedResetMs(evaluation.storedFiveHour)
      if (
        storedResetEpoch === undefined ||
        now < storedResetEpoch + PRIME_DUE_OFFSET_MS
      ) {
        logger.debug('prime', 'not due', { account: evaluation.id })
        return
      }

      let fresh: OAuthQuotaSnapshot
      try {
        fresh = await this.options.refreshQuota(evaluation.id)
      } catch (error) {
        // Quota fresh-check failure: skip this tick without consuming a claim.
        logger.warn('prime', 'refresh failed', {
          account: evaluation.id,
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }

      const freshResetEpoch = storedResetMs(fresh?.five_hour)
      if (freshResetEpoch !== undefined && freshResetEpoch > now) {
        // Window already started by a real request. Record + skip; do not claim.
        logger.debug('prime', 'window active', {
          account: evaluation.id,
          nextReset: fresh.five_hour?.resetsAt,
        })
        this.transient.set(evaluation.id, {
          lastPrimedAt: now,
          lastResult: 'ok',
        })
        return
      }

      // Use the FRESH snapshot's reset epoch if available; fall back to the
      // stored one. The marker key must stay stable per cycle, so picking
      // the older value when the fresh snapshot omits five_hour is correct.
      const markerEpoch = freshResetEpoch ?? storedResetEpoch ?? Math.floor(now)
      const claimed = await this.tryClaim(evaluation.id, markerEpoch)
      if (!claimed) {
        logger.debug('prime', 'claim lost', { account: evaluation.id })
        return
      }

      await this.fire(evaluation, now)
    } catch (error) {
      logger.warn('prime', 'account evaluation failed', {
        account: evaluation.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async tryClaim(
    accountId: 'main' | string,
    resetsAtEpochMs: number,
  ): Promise<boolean> {
    const dir = this.options.markerDir ?? defaultMarkerDir()
    const markerPath = join(dir, `${accountId}-${resetsAtEpochMs}`)
    try {
      await mkdir(dir, { recursive: true })
    } catch {
      // Directory-create failures are propagated by the writeFile attempt below.
    }
    try {
      await writeFile(markerPath, '', { encoding: 'utf8', flag: 'wx' })
      return true
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EEXIST') return false
      throw error
    }
  }

  private async fire(
    evaluation: AccountEvaluation,
    now: number,
  ): Promise<void> {
    let result: PrimeSendResult
    try {
      result = await this.options.sendPrime(evaluation.id)
    } catch (error) {
      // Send threw unexpectedly — treat as a failure and keep the marker.
      const message = error instanceof Error ? error.message : String(error)
      logger.warn('prime', 'prime fire threw', {
        account: evaluation.id,
        error: message,
      })
      this.transient.set(evaluation.id, {
        lastPrimedAt: now,
        lastResult: 'error',
      })
      return
    }

    if (!result.ok) {
      logger.warn('prime', 'prime fire failed', {
        account: evaluation.id,
        status: result.status,
        error: result.error,
      })
      this.transient.set(evaluation.id, {
        lastPrimedAt: now,
        lastResult: 'error',
      })
      return
    }

    const usage = {
      inputTokens: result.usage?.inputTokens,
      outputTokens: result.usage?.outputTokens,
    }
    try {
      const counters = await this.options.recordSuccess(evaluation.id, usage)
      this.counters.set(evaluation.id, counters)
      this.transient.set(evaluation.id, {
        lastPrimedAt: now,
        lastResult: 'ok',
      })
      logger.info('prime', 'prime fired', {
        account: evaluation.id,
        status: result.status,
        ms: result.ms,
        count: counters.count,
        inputTokens: counters.inputTokens,
        outputTokens: counters.outputTokens,
      })
    } catch (error) {
      // Persisting counters failed; surface the error but keep the marker so
      // the cycle counts as attempted. Operator can retry next reset epoch.
      logger.warn('prime', 'recordSuccess failed', {
        account: evaluation.id,
        error: error instanceof Error ? error.message : String(error),
      })
      this.transient.set(evaluation.id, {
        lastPrimedAt: now,
        lastResult: 'error',
      })
    }
  }

  private async sweepMarkers(now: number): Promise<void> {
    const dir = this.options.markerDir ?? defaultMarkerDir()
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    let swept = 0
    for (const entry of entries) {
      try {
        const s = await stat(join(dir, entry))
        if (now - s.mtimeMs > PRIME_MARKER_MAX_AGE_MS) {
          await rm(join(dir, entry), { force: true })
          swept += 1
        }
      } catch {
        // Markers can vanish between readdir and stat; skip silently.
      }
    }
    if (swept > 0) {
      logger.trace('prime', 'swept stale markers', { swept })
    }
  }
}
