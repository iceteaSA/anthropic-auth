import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type AccountStorage,
  FallbackAccountManager,
  getCache1hPersistentMode,
  loadAccounts,
  saveAccounts,
  setCache1hPersistentEnabled,
  setCache1hPersistentMode,
  shouldFallbackStatus,
} from '@cortexkit/anthropic-auth-core'

let tempDir: string
let accountPath: string

const baseStorage = (): AccountStorage => ({
  version: 1,
  main: { type: 'opencode', provider: 'anthropic' },
  fallbackOn: [401, 403, 429],
  refresh: {
    enabled: true,
    intervalMinutes: 10,
    refreshBeforeExpiryMinutes: 30,
  },
  quota: {
    enabled: true,
    checkIntervalMinutes: 5,
    minimumRemaining: { five_hour: 10, seven_day: 20 },
    failClosedOnUnknownQuota: true,
  },
  accounts: [],
})

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'anthropic-auth-test-'))
  accountPath = join(tempDir, 'anthropic-auth.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath
})

afterEach(async () => {
  delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  await rm(tempDir, { recursive: true, force: true })
  mock.restore()
})

describe('account storage', () => {
  test('saves and loads sidecar accounts', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 123,
    })

    await saveAccounts(storage)

    const raw = await readFile(accountPath, 'utf8')
    expect(JSON.parse(raw).accounts[0].id).toBe('fallback-1')
    await expect(loadAccounts()).resolves.toEqual(storage)
  })

  test('malformed sidecar file is ignored', async () => {
    await writeFile(accountPath, '{nope', 'utf8')
    await expect(loadAccounts()).resolves.toBeNull()
  })

  test('preserves relay config when saving storage loaded by older code', async () => {
    await writeFile(
      accountPath,
      JSON.stringify(
        {
          ...baseStorage(),
          relay: {
            enabled: true,
            url: 'https://relay.example.workers.dev',
            token: 'relay-token',
            fallbackToDirect: true,
            transport: 'websocket',
          },
        },
        null,
        2,
      ),
      'utf8',
    )

    const staleStorage = baseStorage()
    staleStorage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 123,
    })

    await saveAccounts(staleStorage)

    const raw = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(raw.relay).toEqual({
      enabled: true,
      url: 'https://relay.example.workers.dev',
      token: 'relay-token',
      fallbackToDirect: true,
      transport: 'websocket',
    })
    expect(raw.accounts).toHaveLength(1)
  })

  test('uses default fallback statuses when not configured', () => {
    expect(shouldFallbackStatus(429, null)).toBe(true)
    expect(shouldFallbackStatus(500, null)).toBe(false)
  })

  test('persists claudeCache enabled state and mode', async () => {
    await setCache1hPersistentEnabled(true)
    let saved = await loadAccounts()

    expect(saved?.claudeCache).toEqual({ enabled: true, mode: 'explicit' })
    expect(getCache1hPersistentMode(saved)).toBe('explicit')

    await setCache1hPersistentMode('hybrid')
    saved = await loadAccounts()

    expect(saved?.claudeCache).toEqual({ enabled: true, mode: 'hybrid' })
    expect(getCache1hPersistentMode(saved)).toBe('hybrid')

    await setCache1hPersistentEnabled(false)
    saved = await loadAccounts()

    expect(saved?.claudeCache).toEqual({ enabled: false, mode: 'hybrid' })
  })
})

describe('FallbackAccountManager', () => {
  test('refreshes expired fallback tokens and persists rotation', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      expires: 100,
      quota: {
        five_hour: { usedPercent: 1, remainingPercent: 99, checkedAt: 900 },
        seven_day: { usedPercent: 2, remainingPercent: 98, checkedAt: 900 },
      },
    })
    await saveAccounts(storage)

    const fetchImpl = mock(
      (_input: string | URL | Request, init?: RequestInit) => {
        const body = new URLSearchParams(String(init?.body))
        expect(body.get('refresh_token')).toBe('old-refresh')
        expect(new Headers(init?.headers).get('content-type')).toBe(
          'application/x-www-form-urlencoded',
        )
        expect(new Headers(init?.headers).get('anthropic-beta')).toBe(
          'oauth-2025-04-20',
        )
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'new-access',
              refresh_token: 'new-refresh',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      },
    ) as unknown as typeof fetch

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => 1_000,
    })

    const accounts = await manager.getUsableFallbackAccounts()
    expect(accounts[0]?.access).toBe('new-access')

    const saved = await loadAccounts()
    expect(saved?.accounts[0]?.refresh).toBe('new-refresh')
    expect(saved?.accounts[0]?.expires).toBe(3_601_000)
    expect(saved?.accounts[0]?.lastRefreshedAt).toBe(1_000)
  })

  test('preserves existing refresh token when refresh response omits rotation', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      expires: 100,
    })
    await saveAccounts(storage)

    const fetchImpl = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'new-access',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => 1_000,
    })

    await manager.refreshDueAccounts()

    const saved = await loadAccounts()
    expect(saved?.accounts[0]?.access).toBe('new-access')
    expect(saved?.accounts[0]?.refresh).toBe('old-refresh')
    expect(saved?.accounts[0]?.lastRefreshedAt).toBe(1_000)
  })

  test('re-reads latest stored token before refreshing stale snapshots', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      expires: 100,
    })
    await saveAccounts(storage)

    const manager = new FallbackAccountManager({
      fetchImpl: mock(() => {
        throw new Error('refresh should not be called')
      }) as unknown as typeof fetch,
      now: () => 2_000,
    })

    const stale = await loadAccounts()
    if (!stale) throw new Error('missing fixture storage')

    const newer = baseStorage()
    newer.accounts.push({
      id: 'fallback-1',
      type: 'oauth',
      access: 'fresh-access',
      refresh: 'fresh-refresh',
      expires: 3_602_000,
    })
    await saveAccounts(newer)

    const refreshed = await manager.refreshAccount(stale.accounts[0]!, stale)

    expect(refreshed.access).toBe('fresh-access')
    expect(stale.accounts[0]?.refresh).toBe('fresh-refresh')
  })

  test('starts an immediate background refresh pass for unused expired fallbacks', async () => {
    const storage = baseStorage()
    storage.quota = { ...storage.quota, enabled: false }
    storage.accounts.push({
      id: 'unused-expired',
      type: 'oauth',
      access: 'expired-access',
      refresh: 'old-refresh',
      expires: 1,
    })
    await saveAccounts(storage)

    const fetchImpl = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'fresh-access',
            refresh_token: 'fresh-refresh',
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => 2_000,
    })

    manager.startBackgroundRefresh()
    await new Promise((resolve) => setTimeout(resolve, 10))
    manager.stopBackgroundRefresh()

    const saved = await loadAccounts()
    expect(saved?.accounts[0]?.access).toBe('fresh-access')
    expect(saved?.accounts[0]?.refresh).toBe('fresh-refresh')
    expect(fetchImpl).toHaveBeenCalled()
  })

  test('skips accounts below configured quota thresholds', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'low-quota',
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 3_601_000,
      quota: {
        five_hour: { usedPercent: 95, remainingPercent: 5, checkedAt: 1_000 },
        seven_day: { usedPercent: 50, remainingPercent: 50, checkedAt: 1_000 },
      },
    })
    await saveAccounts(storage)

    const manager = new FallbackAccountManager({ now: () => 1_001 })
    await expect(manager.getUsableFallbackAccounts()).resolves.toEqual([])
  })

  test('checks stale quota and keeps accounts above threshold', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'fresh-quota',
      type: 'oauth',
      access: 'access',
      refresh: 'refresh',
      expires: 3_601_000,
    })
    await saveAccounts(storage)

    const fetchImpl = mock((input: string | URL | Request) => {
      expect(String(input)).toContain('/api/oauth/usage')
      return Promise.resolve(
        new Response(
          JSON.stringify({
            five_hour: { utilization: 25, resets_at: '2026-01-01T00:00:00Z' },
            seven_day: { utilization: 50, resets_at: '2026-01-07T00:00:00Z' },
          }),
          { status: 200 },
        ),
      )
    }) as unknown as typeof fetch

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => 2_000,
    })

    const accounts = await manager.getUsableFallbackAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.quota?.five_hour?.remainingPercent).toBe(75)
  })

  test('persists token rotation from background quota refresh even when quota is still fresh', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'almost-expired-fresh-quota',
      type: 'oauth',
      access: 'old-access',
      refresh: 'old-refresh',
      expires: 1_600_000,
      quota: {
        five_hour: { usedPercent: 1, remainingPercent: 99, checkedAt: 1_000 },
        seven_day: { usedPercent: 2, remainingPercent: 98, checkedAt: 1_000 },
      },
    })
    await saveAccounts(storage)

    const fetchImpl = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        expect(String(input)).toBe(
          'https://console.anthropic.com/v1/oauth/token',
        )
        const body = new URLSearchParams(String(init?.body))
        expect(body.get('refresh_token')).toBe('old-refresh')
        expect(new Headers(init?.headers).get('content-type')).toBe(
          'application/x-www-form-urlencoded',
        )
        expect(new Headers(init?.headers).get('anthropic-beta')).toBe(
          'oauth-2025-04-20',
        )
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'new-access',
              refresh_token: 'new-refresh',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      },
    ) as unknown as typeof fetch

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => 1_000,
    })

    await manager.refreshQuotaForDueAccounts()

    const saved = await loadAccounts()
    expect(saved?.accounts[0]?.access).toBe('new-access')
    expect(saved?.accounts[0]?.refresh).toBe('new-refresh')
    expect(saved?.accounts[0]?.lastRefreshedAt).toBe(1_000)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  test('refreshes fallback token and retries quota check after stale access token 401', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'stale-access',
      type: 'oauth',
      access: 'old-access',
      refresh: 'refresh-token',
      expires: 3_601_000,
    })
    await saveAccounts(storage)

    const seen: string[] = []
    const fetchImpl = mock(
      (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        if (url.includes('/api/oauth/usage')) {
          seen.push(new Headers(init?.headers).get('authorization') ?? '')
          if (seen.length === 1) {
            return Promise.resolve(new Response('expired', { status: 401 }))
          }
          return Promise.resolve(
            new Response(
              JSON.stringify({
                five_hour: { utilization: 0 },
                seven_day: { utilization: 9 },
              }),
              { status: 200 },
            ),
          )
        }

        expect(url).toBe('https://console.anthropic.com/v1/oauth/token')
        const body = new URLSearchParams(String(init?.body))
        expect(body.get('refresh_token')).toBe('refresh-token')
        expect(new Headers(init?.headers).get('content-type')).toBe(
          'application/x-www-form-urlencoded',
        )
        expect(new Headers(init?.headers).get('anthropic-beta')).toBe(
          'oauth-2025-04-20',
        )
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: 'fresh-access',
              refresh_token: 'fresh-refresh',
              expires_in: 3600,
            }),
            { status: 200 },
          ),
        )
      },
    ) as unknown as typeof fetch

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => 2_000,
    })

    const accounts = await manager.getUsableFallbackAccounts()
    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.access).toBe('fresh-access')
    expect(accounts[0]?.quota?.seven_day?.remainingPercent).toBe(91)
    expect(seen).toEqual(['Bearer old-access', 'Bearer fresh-access'])

    const saved = await loadAccounts()
    expect(saved?.accounts[0]?.refresh).toBe('fresh-refresh')
  })

  test('returns refresh errors from explicit quota refresh', async () => {
    const storage = baseStorage()
    storage.accounts.push({
      id: 'invalid-refresh',
      type: 'oauth',
      access: 'expired-access',
      refresh: 'bad-refresh',
      expires: 1,
    })
    await saveAccounts(storage)

    const fetchImpl = mock(() =>
      Promise.resolve(new Response('invalid_grant', { status: 400 })),
    ) as unknown as typeof fetch

    const manager = new FallbackAccountManager({
      fetchImpl,
      now: () => 2_000,
    })

    const result = await manager.refreshQuotaForAllAccounts()
    expect(result.storage?.accounts[0]?.quota).toBeUndefined()
    expect(result.errors).toEqual([
      {
        accountId: 'invalid-refresh',
        message: 'Claude OAuth refresh failed: 400 — invalid_grant',
      },
    ])
    const saved = await loadAccounts()
    expect(saved?.accounts[0]?.lastQuotaRefreshError?.message).toBe(
      'Claude OAuth refresh failed: 400 — invalid_grant',
    )
  })
})
