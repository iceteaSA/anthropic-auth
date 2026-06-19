import type { AccountStorage, FallbackAccount } from '../accounts.ts'

export const CLAUDE_ACCOUNT_COMMAND_NAME = 'claude-account'

export type AccountCommandAction =
  | { type: 'status' }
  | { type: 'enable'; id: string }
  | { type: 'disable'; id: string }
  | { type: 'remove'; id: string }
  | { type: 'move-up'; id: string }
  | { type: 'move-down'; id: string }
  | { type: 'usage' }

export function parseAccountCommandAction(
  argumentsText: string,
): AccountCommandAction {
  const parts = argumentsText.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return { type: 'status' }

  const action = parts[0]
  const id = parts.slice(1).join(' ')

  if (action === 'enable' && id) return { type: 'enable', id }
  if (action === 'disable' && id) return { type: 'disable', id }
  if (action === 'remove' && id) return { type: 'remove', id }
  if (action === 'move-up' && id) return { type: 'move-up', id }
  if (action === 'move-down' && id) return { type: 'move-down', id }

  return { type: 'usage' }
}

export interface AccountListItem {
  id: string
  label: string
  role: 'main' | 'fallback'
  enabled: boolean
  quotaPercent: number | null
}

export function buildAccountList(storage: AccountStorage): AccountListItem[] {
  const list: AccountListItem[] = []

  const fiveHour = storage.quota?.mainQuota?.five_hour
  list.push({
    id: 'main',
    label:
      storage.main?.provider === 'anthropic' ? 'OpenCode anthropic' : 'Main',
    role: 'main',
    enabled: true,
    quotaPercent: fiveHour?.usedPercent ?? null,
  })

  for (const account of storage.accounts) {
    const fiveHourQuota = (
      account as { quota?: { five_hour?: { usedPercent: number } } }
    ).quota?.five_hour
    list.push({
      id: account.id,
      label: account.label ?? account.id,
      role: 'fallback',
      enabled: account.enabled !== false,
      quotaPercent: fiveHourQuota?.usedPercent ?? null,
    })
  }

  return list
}

const USAGE_TEXT = [
  'Usage:',
  '  /claude-account                  Show account list',
  '  /claude-account enable <id>      Enable a fallback account',
  '  /claude-account disable <id>     Disable a fallback account',
  '  /claude-account remove <id>      Remove a fallback account',
  '  /claude-account move-up <id>     Move a fallback account up',
  '  /claude-account move-down <id>   Move a fallback account down',
].join('\n')

export function executeAccountCommand(input: {
  argumentsText: string
  storage: AccountStorage
}): {
  text: string
  updated?: {
    id: string
    action: 'enable' | 'disable' | 'remove' | 'reorder'
    enabled?: boolean
    previousOrder?: string[]
    newOrder?: string[]
  }
} {
  const action = parseAccountCommandAction(input.argumentsText)
  const accounts = input.storage.accounts
  const mainId = 'main'

  if (action.type === 'status') {
    const list = buildAccountList(input.storage)
    const lines = ['## Claude Accounts', '']
    for (const a of list) {
      const pct =
        a.quotaPercent != null ? ` ${Math.round(a.quotaPercent)}%` : ''
      const status = !a.enabled ? ' (disabled)' : ''
      lines.push(`- **${a.label}** [${a.role}]${status}${pct}`)
    }
    lines.push('', USAGE_TEXT)
    return { text: lines.join('\n') }
  }

  if (action.type === 'usage') {
    return { text: USAGE_TEXT }
  }

  const id = action.id
  if (id === mainId) {
    return {
      text: `Cannot ${action.type} the main account (OpenCode managed).`,
    }
  }

  if (action.type === 'enable' || action.type === 'disable') {
    const target = accounts.find((a) => a.id === id)
    if (!target) {
      return { text: `Account "${id}" not found.` }
    }
    return {
      text: `Account "${target.label ?? id}" ${action.type}d.`,
      updated: {
        id,
        action: action.type,
        enabled: action.type === 'enable',
      },
    }
  }

  if (action.type === 'remove') {
    const target = accounts.find((a) => a.id === id)
    if (!target) {
      return { text: `Account "${id}" not found.` }
    }
    return {
      text: `Account "${target.label ?? id}" removed.`,
      updated: { id, action: 'remove' },
    }
  }

  if (action.type === 'move-up') {
    const idx = accounts.findIndex((a) => a.id === id)
    if (idx < 0) {
      return { text: `Account "${id}" not found.` }
    }
    if (idx === 0) {
      return {
        text: `Account "${accounts[idx]?.label ?? id}" is already first.`,
      }
    }
    const previousOrder = accounts.map((a) => a.id)
    const newAccounts = [...accounts]
    ;[newAccounts[idx - 1], newAccounts[idx]] = [
      newAccounts[idx] as FallbackAccount,
      newAccounts[idx - 1] as FallbackAccount,
    ]
    const newOrder = newAccounts.map((a) => a.id)
    return {
      text: `Account "${accounts[idx]?.label ?? id}" moved up.`,
      updated: { id, action: 'reorder', previousOrder, newOrder },
    }
  }

  if (action.type === 'move-down') {
    const idx = accounts.findIndex((a) => a.id === id)
    if (idx < 0) {
      return { text: `Account "${id}" not found.` }
    }
    if (idx === accounts.length - 1) {
      return {
        text: `Account "${accounts[idx]?.label ?? id}" is already last.`,
      }
    }
    const previousOrder = accounts.map((a) => a.id)
    const newAccounts = [...accounts]
    ;[newAccounts[idx], newAccounts[idx + 1]] = [
      newAccounts[idx + 1] as FallbackAccount,
      newAccounts[idx] as FallbackAccount,
    ]
    const newOrder = newAccounts.map((a) => a.id)
    return {
      text: `Account "${accounts[idx]?.label ?? id}" moved down.`,
      updated: { id, action: 'reorder', previousOrder, newOrder },
    }
  }

  return { text: USAGE_TEXT }
}
