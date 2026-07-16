import {
  type AccountQuotaWindow,
  type AccountStorage,
  isOAuthAccount,
  killswitchPassesPolicy,
  type OAuthQuotaSnapshot,
} from './accounts.ts'
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
