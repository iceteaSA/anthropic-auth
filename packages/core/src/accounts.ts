import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { refreshClaudeOAuthToken } from './auth.ts'
import {
  CACHE_1H_MODES,
  type Cache1hMode,
  CLAUDE_CODE_VERSION,
  DEFAULT_CACHE_1H_MODE,
} from './constants.ts'

export const ACCOUNT_FILE_NAME = 'anthropic-auth.json'
export const QUOTA_URL = 'https://api.anthropic.com/api/oauth/usage'

export type QuotaWindowName = 'five_hour' | 'seven_day'

export type OAuthAccount = {
  id: string
  label?: string
  type: 'oauth'
  access?: string
  refresh: string
  expires?: number
  enabled?: boolean
  addedAt?: number
  lastUsed?: number
  lastRefreshedAt?: number
  lastRefreshError?: AccountOperationError
  lastQuotaRefreshError?: AccountOperationError
  quota?: Partial<Record<QuotaWindowName, AccountQuotaWindow>>
}

export type AccountOperationError = {
  message: string
  checkedAt: number
}

export type AccountQuotaWindow = {
  usedPercent: number
  remainingPercent: number
  resetsAt?: string
  checkedAt: number
}

export type AccountStorage = {
  version: 1
  main?: {
    type: 'opencode'
    provider: 'anthropic'
  }
  fallbackOn?: number[]
  refresh?: {
    enabled?: boolean
    intervalMinutes?: number
    refreshBeforeExpiryMinutes?: number
  }
  quota?: {
    enabled?: boolean
    checkIntervalMinutes?: number
    minimumRemaining?: Partial<Record<QuotaWindowName | '5h' | '1w', number>>
    failClosedOnUnknownQuota?: boolean
  }
  claudeCache?: {
    enabled?: boolean
    mode?: Cache1hMode
  }
  dump?: {
    enabled?: boolean
  }
  claudeFast?: {
    enabled?: boolean
  }
  relay?: {
    enabled?: boolean
    url?: string
    token?: string
    fallbackToDirect?: boolean
    transport?: 'http' | 'websocket'
  }
  accounts: OAuthAccount[]
}

type OAuthUsageWindow = {
  utilization?: number
  resets_at?: string
}

type OAuthUsageResponse = {
  five_hour?: OAuthUsageWindow
  seven_day?: OAuthUsageWindow
}

export type OAuthQuotaSnapshot = Partial<
  Record<QuotaWindowName, AccountQuotaWindow>
>

export type AccountManagerOptions = {
  now?: () => number
  fetchImpl?: typeof fetch
  configPath?: string
  quotaManager?: import('./quota-manager.ts').QuotaManager
}

export type AccountRefreshError = {
  accountId: string
  message: string
}

const DEFAULT_FALLBACK_ON = [401, 403, 429]
const DEFAULT_REFRESH_BEFORE_EXPIRY_MINUTES = 30
const DEFAULT_QUOTA_CHECK_INTERVAL_MINUTES = 5
const DEFAULT_MINIMUM_REMAINING: Record<QuotaWindowName, number> = {
  five_hour: 0,
  seven_day: 0,
}
const DEFAULT_FAIL_CLOSED_ON_UNKNOWN_QUOTA = true
const BACKGROUND_TICK_MS = 60_000

function getConfigDir() {
  if (process.env.OPENCODE_CONFIG_DIR?.trim()) {
    return process.env.OPENCODE_CONFIG_DIR.trim()
  }
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'opencode',
  )
}

export function getAccountStoragePath() {
  return (
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE?.trim() ||
    join(getConfigDir(), ACCOUNT_FILE_NAME)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeAccount(value: unknown): OAuthAccount | null {
  if (!isRecord(value)) return null
  if (value.type !== 'oauth') return null
  if (typeof value.refresh !== 'string' || !value.refresh.trim()) return null

  return {
    id:
      typeof value.id === 'string' && value.id.trim()
        ? value.id.trim()
        : randomUUID(),
    label: typeof value.label === 'string' ? value.label : undefined,
    type: 'oauth',
    access: typeof value.access === 'string' ? value.access : undefined,
    refresh: value.refresh,
    expires: typeof value.expires === 'number' ? value.expires : undefined,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
    addedAt: typeof value.addedAt === 'number' ? value.addedAt : undefined,
    lastUsed: typeof value.lastUsed === 'number' ? value.lastUsed : undefined,
    lastRefreshedAt:
      typeof value.lastRefreshedAt === 'number'
        ? value.lastRefreshedAt
        : undefined,
    lastRefreshError: normalizeOperationError(value.lastRefreshError),
    lastQuotaRefreshError: normalizeOperationError(value.lastQuotaRefreshError),
    quota: normalizeQuota(value.quota),
  }
}

function normalizeOperationError(
  value: unknown,
): AccountOperationError | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.message !== 'string') return undefined
  const checkedAt = Number(value.checkedAt)
  if (!Number.isFinite(checkedAt)) return undefined
  return { message: value.message, checkedAt }
}

function normalizeQuota(value: unknown): OAuthAccount['quota'] {
  if (!isRecord(value)) return undefined
  const quota: OAuthAccount['quota'] = {}
  for (const key of ['five_hour', 'seven_day'] as const) {
    const window = value[key]
    if (!isRecord(window)) continue
    const usedPercent = Number(window.usedPercent)
    const remainingPercent = Number(window.remainingPercent)
    const checkedAt = Number(window.checkedAt)
    if (
      !Number.isFinite(usedPercent) ||
      !Number.isFinite(remainingPercent) ||
      !Number.isFinite(checkedAt)
    ) {
      continue
    }
    quota[key] = {
      usedPercent,
      remainingPercent,
      checkedAt,
      resetsAt:
        typeof window.resetsAt === 'string' ? window.resetsAt : undefined,
    }
  }
  return Object.keys(quota).length ? quota : undefined
}

function normalizeStorage(value: unknown): AccountStorage | null {
  if (!isRecord(value) || !Array.isArray(value.accounts)) return null
  return {
    version: 1,
    main: { type: 'opencode', provider: 'anthropic' },
    fallbackOn: Array.isArray(value.fallbackOn)
      ? value.fallbackOn.filter((status) => Number.isInteger(status))
      : undefined,
    refresh: isRecord(value.refresh) ? value.refresh : undefined,
    quota: isRecord(value.quota) ? value.quota : undefined,
    claudeCache: isRecord(value.claudeCache) ? value.claudeCache : undefined,
    dump: isRecord(value.dump) ? value.dump : undefined,
    claudeFast: isRecord(value.claudeFast) ? value.claudeFast : undefined,
    relay: isRecord(value.relay) ? value.relay : undefined,
    accounts: value.accounts
      .map(normalizeAccount)
      .filter((account): account is OAuthAccount => account != null),
  }
}

export async function loadAccounts(path = getAccountStoragePath()) {
  try {
    const raw = await readFile(path, 'utf8')
    return normalizeStorage(JSON.parse(raw))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    return null
  }
}

async function loadExistingTopLevelFields(path: string) {
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function omitUndefinedTopLevel(value: AccountStorage) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  )
}

export async function saveAccounts(
  storage: AccountStorage,
  path = getAccountStoragePath(),
) {
  await mkdir(dirname(path), { recursive: true })
  const existing = await loadExistingTopLevelFields(path)
  const next = { ...existing, ...omitUndefinedTopLevel(storage) }
  const tempPath = `${path}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(tempPath, path)
}

export function isCache1hPersistentlyEnabled(storage: AccountStorage | null) {
  return storage?.claudeCache?.enabled === true
}

function normalizeCache1hMode(value: unknown): Cache1hMode {
  return typeof value === 'string' &&
    CACHE_1H_MODES.includes(value as Cache1hMode)
    ? (value as Cache1hMode)
    : DEFAULT_CACHE_1H_MODE
}

export function getCache1hPersistentMode(
  storage: AccountStorage | null,
): Cache1hMode {
  return normalizeCache1hMode(storage?.claudeCache?.mode)
}

export async function setCache1hPersistentEnabled(
  enabled: boolean,
  mode?: Cache1hMode,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? {
    version: 1,
    main: { type: 'opencode' as const, provider: 'anthropic' as const },
    accounts: [],
  }
  storage.claudeCache = {
    ...(storage.claudeCache ?? {}),
    enabled,
    mode: mode ?? getCache1hPersistentMode(storage),
  }
  await saveAccounts(storage, path)
  return storage
}

export async function setCache1hPersistentMode(
  mode: Cache1hMode,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? {
    version: 1,
    main: { type: 'opencode' as const, provider: 'anthropic' as const },
    accounts: [],
  }
  storage.claudeCache = {
    ...(storage.claudeCache ?? {}),
    enabled: storage.claudeCache?.enabled === true,
    mode,
  }
  await saveAccounts(storage, path)
  return storage
}

export function isDumpPersistentlyEnabled(storage: AccountStorage | null) {
  return storage?.dump?.enabled === true
}

export async function setDumpPersistentEnabled(
  enabled: boolean,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? {
    version: 1,
    main: { type: 'opencode' as const, provider: 'anthropic' as const },
    accounts: [],
  }
  storage.dump = {
    ...(storage.dump ?? {}),
    enabled,
  }
  await saveAccounts(storage, path)
  return storage
}

export function isFastModePersistentlyEnabled(storage: AccountStorage | null) {
  return storage?.claudeFast?.enabled === true
}

export async function setFastModePersistentEnabled(
  enabled: boolean,
  path = getAccountStoragePath(),
) {
  const storage = (await loadAccounts(path)) ?? {
    version: 1,
    main: { type: 'opencode' as const, provider: 'anthropic' as const },
    accounts: [],
  }
  storage.claudeFast = {
    ...(storage.claudeFast ?? {}),
    enabled,
  }
  await saveAccounts(storage, path)
  return storage
}

function getFallbackStatuses(storage: AccountStorage | null) {
  return storage?.fallbackOn?.length ? storage.fallbackOn : DEFAULT_FALLBACK_ON
}

export function shouldFallbackStatus(
  status: number,
  storage: AccountStorage | null,
) {
  return getFallbackStatuses(storage).includes(status)
}

function normalizeThresholds(storage: AccountStorage | null) {
  const configured = storage?.quota?.minimumRemaining || {}
  return {
    five_hour:
      configured.five_hour ??
      configured['5h'] ??
      DEFAULT_MINIMUM_REMAINING.five_hour,
    seven_day:
      configured.seven_day ??
      configured['1w'] ??
      DEFAULT_MINIMUM_REMAINING.seven_day,
  }
}

function quotaEnabled(storage: AccountStorage | null) {
  return storage?.quota?.enabled !== false
}

function refreshEnabled(storage: AccountStorage | null) {
  return storage?.refresh?.enabled !== false
}

function refreshBeforeExpiryMs(storage: AccountStorage | null) {
  const minutes =
    storage?.refresh?.refreshBeforeExpiryMinutes ??
    DEFAULT_REFRESH_BEFORE_EXPIRY_MINUTES
  return Math.max(0, minutes) * 60_000
}

export function getQuotaCheckIntervalMs(storage: AccountStorage | null) {
  const minutes =
    storage?.quota?.checkIntervalMinutes ?? DEFAULT_QUOTA_CHECK_INTERVAL_MINUTES
  return Math.max(1, minutes) * 60_000
}

function failClosedOnUnknownQuota(storage: AccountStorage | null) {
  return (
    storage?.quota?.failClosedOnUnknownQuota ??
    DEFAULT_FAIL_CLOSED_ON_UNKNOWN_QUOTA
  )
}

export function quotaSnapshotPassesPolicy(
  quota: OAuthQuotaSnapshot | undefined,
  storage: AccountStorage | null,
) {
  if (!quotaEnabled(storage)) return true
  const thresholds = normalizeThresholds(storage)
  for (const key of ['five_hour', 'seven_day'] as const) {
    const window = quota?.[key]
    if (!window) return !failClosedOnUnknownQuota(storage)
    if (window.remainingPercent < thresholds[key]) return false
  }
  return true
}

export function getQuotaNextRefreshAt(
  quota: OAuthQuotaSnapshot | undefined,
  storage: AccountStorage | null,
  now: number,
) {
  if (!quotaEnabled(storage)) return now + getQuotaCheckIntervalMs(storage)

  const thresholds = normalizeThresholds(storage)
  const blockedResetTimes: number[] = []
  for (const key of ['five_hour', 'seven_day'] as const) {
    const window = quota?.[key]
    if (!window) return now + getQuotaCheckIntervalMs(storage)
    if (window.remainingPercent >= thresholds[key]) continue
    const resetTime = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN
    if (!Number.isFinite(resetTime) || resetTime <= now) {
      return now + getQuotaCheckIntervalMs(storage)
    }
    blockedResetTimes.push(resetTime)
  }

  if (!blockedResetTimes.length) return now + getQuotaCheckIntervalMs(storage)
  return Math.min(...blockedResetTimes) + 60_000
}

function tokenNeedsRefresh(
  account: OAuthAccount,
  storage: AccountStorage | null,
  now: number,
) {
  return (
    !account.access ||
    !account.expires ||
    account.expires - now <= refreshBeforeExpiryMs(storage)
  )
}

function quotaIsStale(
  account: OAuthAccount,
  storage: AccountStorage | null,
  now: number,
) {
  if (!quotaEnabled(storage)) return false
  const maxAge = getQuotaCheckIntervalMs(storage)
  return (['five_hour', 'seven_day'] as const).some((key) => {
    const window = account.quota?.[key]
    return !window || now - window.checkedAt >= maxAge
  })
}

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 100) return 100
  return value
}

function mapUsageWindow(
  window: OAuthUsageWindow | undefined,
  checkedAt: number,
): AccountQuotaWindow | undefined {
  if (typeof window?.utilization !== 'number') return undefined
  const usedPercent = clampPercent(window.utilization)
  return {
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    resetsAt: window.resets_at,
    checkedAt,
  }
}

export async function fetchOAuthQuotaSnapshot(input: {
  accessToken: string
  fetchImpl?: typeof fetch
  now?: () => number
}) {
  const fetchImpl = input.fetchImpl ?? fetch
  const response = await fetchImpl(QUOTA_URL, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': `claude-code/${CLAUDE_CODE_VERSION}`,
    },
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Claude quota check failed: ${response.status} — ${body}`)
  }

  const checkedAt = input.now?.() ?? Date.now()
  const usage = (await response.json()) as OAuthUsageResponse
  return {
    five_hour: mapUsageWindow(usage.five_hour, checkedAt),
    seven_day: mapUsageWindow(usage.seven_day, checkedAt),
  } satisfies OAuthQuotaSnapshot
}

function updateStoredAccount(storage: AccountStorage, account: OAuthAccount) {
  const index = storage.accounts.findIndex(
    (candidate) => candidate.id === account.id,
  )
  if (index >= 0) storage.accounts[index] = account
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function recordRefreshError(
  account: OAuthAccount,
  error: unknown,
  now: number,
) {
  account.lastRefreshError = {
    message: formatErrorMessage(error),
    checkedAt: now,
  }
}

function recordQuotaRefreshError(
  account: OAuthAccount,
  error: unknown,
  now: number,
) {
  account.lastQuotaRefreshError = {
    message: formatErrorMessage(error),
    checkedAt: now,
  }
}

export class FallbackAccountManager {
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch
  private readonly configPath: string
  private readonly refreshPromises = new Map<string, Promise<OAuthAccount>>()
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private quotaTimer: ReturnType<typeof setInterval> | null = null
  readonly quotaManager: import('./quota-manager.ts').QuotaManager | null

  constructor(options: AccountManagerOptions = {}) {
    this.now = options.now ?? Date.now
    this.fetchImpl = options.fetchImpl ?? fetch
    this.configPath = options.configPath ?? getAccountStoragePath()
    this.quotaManager = options.quotaManager ?? null
  }

  /**
   * Seed QuotaManager from persisted account.quota if no cache entry exists
   * yet. Prevents unnecessary API calls when the on-disk snapshot is fresh.
   */
  private seedFallbackQuota(
    account: OAuthAccount,
    storage: AccountStorage,
  ): void {
    if (!this.quotaManager) return
    if (this.quotaManager.getFallback(account.id)) return
    if (!account.quota) return
    const checkedAt = Math.max(
      account.quota.five_hour?.checkedAt ?? 0,
      account.quota.seven_day?.checkedAt ?? 0,
    )
    if (checkedAt <= 0) return
    const checkInterval = getQuotaCheckIntervalMs(storage)
    this.quotaManager.setFallback(account.id, {
      quota: account.quota,
      refreshAfter: checkedAt + checkInterval,
      checkedAt,
    })
  }

  async load() {
    return loadAccounts(this.configPath)
  }

  async save(storage: AccountStorage) {
    await saveAccounts(storage, this.configPath)
  }

  startBackgroundRefresh() {
    void this.refreshDueAccounts().catch(() => {})
    void this.refreshQuotaForDueAccounts().catch(() => {})
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => {
        void this.refreshDueAccounts().catch(() => {})
      }, BACKGROUND_TICK_MS)
      if ('unref' in this.refreshTimer) this.refreshTimer.unref()
    }
    if (!this.quotaTimer) {
      this.quotaTimer = setInterval(() => {
        void this.refreshQuotaForDueAccounts().catch(() => {})
      }, BACKGROUND_TICK_MS)
      if ('unref' in this.quotaTimer) this.quotaTimer.unref()
    }
  }

  stopBackgroundRefresh() {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    if (this.quotaTimer) clearInterval(this.quotaTimer)
    this.refreshTimer = null
    this.quotaTimer = null
  }

  async getUsableFallbackAccounts() {
    const storage = await this.load()
    if (!storage) return []
    const usable: OAuthAccount[] = []
    let changed = false

    for (const account of storage.accounts) {
      if (account.enabled === false) continue
      try {
        let next = account
        if (tokenNeedsRefresh(next, storage, this.now())) {
          next = await this.refreshAccount(next, storage)
          changed = true
        }
        this.seedFallbackQuota(next, storage)
        const stale = this.quotaManager
          ? this.quotaManager.isFallbackStale(next.id)
          : quotaIsStale(next, storage, this.now())
        if (stale) {
          next = await this.refreshAccountQuota(next, storage)
          changed = true
        }
        if (this.accountPassesQuotaPolicy(next, storage)) usable.push(next)
      } catch {
        if (!failClosedOnUnknownQuota(storage)) usable.push(account)
      }
    }

    if (changed) await this.save(storage)
    return usable
  }

  async markUsed(account: OAuthAccount) {
    const storage = await this.load()
    if (!storage) return
    const stored = storage.accounts.find(
      (candidate) => candidate.id === account.id,
    )
    if (!stored) return
    stored.lastUsed = this.now()
    await this.save(storage)
  }

  accountPassesQuotaPolicy(
    account: OAuthAccount,
    storage: AccountStorage | null,
  ) {
    return quotaSnapshotPassesPolicy(account.quota, storage)
  }

  async refreshDueAccounts() {
    const storage = await this.load()
    if (!storage || !refreshEnabled(storage)) return
    let changed = false
    for (const account of storage.accounts) {
      if (account.enabled === false) continue
      if (!tokenNeedsRefresh(account, storage, this.now())) continue
      try {
        await this.refreshAccount(account, storage)
        changed = true
      } catch (error) {
        recordRefreshError(account, error, this.now())
        updateStoredAccount(storage, account)
        changed = true
        // Background refresh must not break the plugin request path.
      }
    }
    if (changed) await this.save(storage)
  }

  async refreshQuotaForDueAccounts() {
    const storage = await this.load()
    if (!storage || !quotaEnabled(storage)) return
    let changed = false
    for (const account of storage.accounts) {
      if (account.enabled === false) continue
      let next = account
      try {
        if (tokenNeedsRefresh(next, storage, this.now())) {
          next = await this.refreshAccount(next, storage)
          changed = true
        }
        this.seedFallbackQuota(next, storage)
        // Use QuotaManager staleness when available (shared cache);
        // fall back to per-account on-disk staleness otherwise.
        const stale = this.quotaManager
          ? this.quotaManager.isFallbackStale(next.id)
          : quotaIsStale(next, storage, this.now())
        if (!stale) continue
        await this.refreshAccountQuota(next, storage)
        changed = true
      } catch (error) {
        recordQuotaRefreshError(account, error, this.now())
        updateStoredAccount(storage, account)
        changed = true
        // Quota probes are advisory; failed probes fail closed at selection time.
      }
    }
    if (changed) await this.save(storage)
  }

  async refreshQuotaForAllAccounts() {
    const storage = await this.load()
    const errors: AccountRefreshError[] = []
    if (!storage || !quotaEnabled(storage)) return { storage, errors }
    let changed = false
    for (const account of storage.accounts) {
      if (account.enabled === false) continue
      let next = account
      try {
        if (tokenNeedsRefresh(next, storage, this.now())) {
          next = await this.refreshAccount(next, storage)
          changed = true
        }
        await this.refreshAccountQuota(next, storage)
        changed = true
      } catch (error) {
        recordQuotaRefreshError(account, error, this.now())
        updateStoredAccount(storage, account)
        changed = true
        errors.push({
          accountId: account.id,
          message: formatErrorMessage(error),
        })
      }
    }
    if (changed) await this.save(storage)
    return { storage, errors }
  }

  async refreshAccount(
    account: OAuthAccount,
    storage: AccountStorage,
    options: { force?: boolean } = {},
  ) {
    const existing = this.refreshPromises.get(account.id)
    if (existing) {
      const refreshed = await existing
      updateStoredAccount(storage, refreshed)
      return refreshed
    }

    const promise = this.refreshAccountNow(account, storage, options).finally(
      () => {
        this.refreshPromises.delete(account.id)
      },
    )
    this.refreshPromises.set(account.id, promise)
    const refreshed = await promise
    updateStoredAccount(storage, refreshed)
    return refreshed
  }

  private async refreshAccountNow(
    account: OAuthAccount,
    storage: AccountStorage,
    options: { force?: boolean },
  ) {
    const latestStorage = await this.load()
    const latestAccount = latestStorage?.accounts.find(
      (candidate) => candidate.id === account.id,
    )
    if (
      latestAccount &&
      !options.force &&
      !tokenNeedsRefresh(latestAccount, latestStorage, this.now())
    ) {
      updateStoredAccount(storage, latestAccount)
      return latestAccount
    }

    const sourceAccount = latestAccount ?? account
    const refreshToken = sourceAccount.refresh
    const refreshed = await refreshClaudeOAuthToken({
      refreshToken,
      fetchImpl: this.fetchImpl,
      now: this.now,
    })
    sourceAccount.access = refreshed.access
    sourceAccount.refresh = refreshed.refresh
    sourceAccount.expires = refreshed.expires
    sourceAccount.lastRefreshedAt =
      refreshed.expires - refreshed.expiresIn * 1000
    sourceAccount.lastRefreshError = undefined
    updateStoredAccount(storage, sourceAccount)
    return sourceAccount
  }

  async refreshAccountQuota(account: OAuthAccount, storage: AccountStorage) {
    let target = account
    if (!target.access) {
      throw new Error(`Fallback account ${account.id} has no access token`)
    }
    try {
      target.quota = await fetchOAuthQuotaSnapshot({
        accessToken: target.access,
        fetchImpl: this.fetchImpl,
        now: this.now,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('Claude quota check failed: 401')) throw error
      target = await this.refreshAccount(account, storage, {
        force: true,
      })
      if (!target.access) throw error
      target.quota = await fetchOAuthQuotaSnapshot({
        accessToken: target.access,
        fetchImpl: this.fetchImpl,
        now: this.now,
      })
    }
    target.lastQuotaRefreshError = undefined
    updateStoredAccount(storage, target)
    // Sync to shared QuotaManager so all consumers see the same cache
    if (this.quotaManager && target.quota) {
      const now = this.now()
      this.quotaManager.setFallback(target.id, {
        quota: target.quota,
        refreshAfter: now + getQuotaCheckIntervalMs(storage),
        checkedAt: now,
      })
    }
    return target
  }
}
