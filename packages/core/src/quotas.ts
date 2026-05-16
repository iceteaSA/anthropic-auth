import {
  type AccountQuotaWindow,
  type AccountStorage,
  type KillswitchConfig,
  killswitchPassesPolicy,
  type OAuthAccount,
  type OAuthQuotaSnapshot,
  type QuotaWindowName,
} from './accounts.ts'

export const CLAUDE_QUOTAS_COMMAND_NAME = 'claude-quota'

const WINDOW_LABELS: Record<QuotaWindowName, string> = {
  five_hour: '5h',
  seven_day: '1w',
}

export type QuotaAccountSummary = {
  id?: string
  name: string
  role: 'main' | 'fallback'
  enabled?: boolean
  quota?: OAuthQuotaSnapshot
  lastRefreshedAt?: number
  error?: string
}

function formatPercent(value: number) {
  return `${Math.round(value * 10) / 10}%`
}

function formatAge(checkedAt: number, now: number) {
  const elapsedMs = Math.max(0, now - checkedAt)
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes === 1) return '1m ago'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (remainder === 0) return `${hours}h ago`
  return `${hours}h ${remainder}m ago`
}

function formatResetDuration(resetsAt: string, now: number) {
  const resetTime = Date.parse(resetsAt)
  if (!Number.isFinite(resetTime)) return resetsAt

  const remainingMs = resetTime - now
  if (remainingMs <= 0) return 'now'

  const totalMinutes = Math.max(1, Math.ceil(remainingMs / 60_000))
  if (totalMinutes < 60) return `in ${totalMinutes}m`

  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (minutes === 0) return `in ${hours}h`
  return `in ${hours}h ${minutes}m`
}

function formatReset(resetsAt: string | undefined, now: number) {
  if (!resetsAt) return ''
  return `, resets ${formatResetDuration(resetsAt, now)}`
}

function formatWindow(
  key: QuotaWindowName,
  window: AccountQuotaWindow | undefined,
  now: number,
) {
  if (!window) return `  - ${WINDOW_LABELS[key]}: unknown`
  return [
    `  - ${WINDOW_LABELS[key]}: ${formatPercent(window.remainingPercent)} remaining`,
    ` (${formatPercent(window.usedPercent)} used`,
    `${formatReset(window.resetsAt, now)}, checked ${formatAge(window.checkedAt, now)})`,
  ].join('')
}

function accountName(account: OAuthAccount) {
  return account.label?.trim() || account.id
}

function accountStoredError(account: OAuthAccount) {
  return (
    account.lastQuotaRefreshError?.message ?? account.lastRefreshError?.message
  )
}

export function buildFallbackQuotaSummaries(
  storage: AccountStorage | null,
  errors: ReadonlyMap<string, string> = new Map(),
) {
  if (!storage?.accounts.length) return []
  return storage.accounts.map((account) => {
    const error = errors.get(account.id) ?? accountStoredError(account)
    return {
      id: account.id,
      name: accountName(account),
      role: 'fallback' as const,
      enabled: account.enabled !== false,
      quota: account.quota,
      lastRefreshedAt: account.lastRefreshedAt,
      ...(error && { error }),
    }
  })
}

export function buildClaudeQuotaSummary(input: {
  accounts: QuotaAccountSummary[]
  refreshedAt?: number
  killswitch?: KillswitchConfig
  /** Full storage needed for killswitchPassesPolicy evaluation */
  storage?: AccountStorage | null
  now?: number
}) {
  const now = input.now ?? Date.now()
  const lines = ['## Claude Quotas', '']

  if (input.refreshedAt) {
    lines.push(`Refreshed: ${formatAge(input.refreshedAt, now)}`, '')
  }

  if (!input.accounts.length) {
    lines.push('No Claude OAuth accounts found yet.')
    return lines.join('\n')
  }

  for (const account of input.accounts) {
    const role = account.role === 'main' ? 'main' : 'fallback'
    const disabled = account.enabled === false ? ' disabled' : ''
    lines.push(`### ${account.name} (${role}${disabled})`)
    if (account.lastRefreshedAt) {
      lines.push(
        `  - Last token refresh: ${formatAge(account.lastRefreshedAt, now)}`,
      )
    }
    if (account.error) {
      lines.push(`  - Error: ${account.error}`)
    }
    lines.push(formatWindow('five_hour', account.quota?.five_hour, now))
    lines.push(formatWindow('seven_day', account.quota?.seven_day, now))
    lines.push('')
  }

  // Killswitch status
  const ks = input.killswitch
  if (ks) {
    lines.push(`### Killswitch: ${ks.enabled ? 'ON' : 'OFF'}`)
    if (ks.enabled) {
      const mainT = ks.main ?? {}
      const mfh = mainT.five_hour ?? mainT['5h'] ?? 5
      const msd = mainT.seven_day ?? mainT['1w'] ?? 10
      const mainAccount = input.accounts.find((a) => a.role === 'main')
      const mainStatus =
        ks.enabled && input.storage && mainAccount?.quota
          ? killswitchPassesPolicy(mainAccount.quota, input.storage)
            ? 'active'
            : 'KILLED'
          : ''
      const mainSuffix = mainStatus ? ` \u2014 ${mainStatus}` : ''
      lines.push(`  - main: 5h \u2265 ${mfh}%, 1w \u2265 ${msd}%${mainSuffix}`)
      if (ks.accounts) {
        for (const [id, t] of Object.entries(ks.accounts)) {
          const fh = t.five_hour ?? t['5h'] ?? mfh
          const sd = t.seven_day ?? t['1w'] ?? msd
          const fb = input.accounts.find(
            (a) => a.role === 'fallback' && (a.id === id || a.name === id),
          )
          const fbStatus =
            input.storage && fb?.quota
              ? killswitchPassesPolicy(fb.quota, input.storage, id)
                ? 'active'
                : 'KILLED'
              : ''
          const fbSuffix = fbStatus ? ` \u2014 ${fbStatus}` : ''
          lines.push(`  - ${id}: 5h \u2265 ${fh}%, 1w \u2265 ${sd}%${fbSuffix}`)
        }
      }
    }
    lines.push('')
  }

  return lines.join('\n').trimEnd()
}
