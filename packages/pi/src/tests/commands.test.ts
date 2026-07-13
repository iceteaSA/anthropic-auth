import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CacheKeepSessionRegistry } from '@cortexkit/anthropic-auth-core'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent'
import { registerCommands } from '../commands'

const ENV_KEY = 'PI_ANTHROPIC_AUTH_FILE'
const CACHEKEEP_REGISTRY_ENV_KEY = 'PI_ANTHROPIC_AUTH_CACHEKEEP_REGISTRY_DIR'

function mockNotify(): { ctx: ExtensionCommandContext; notified: string[] } {
  const notified: string[] = []
  const ctx = {
    ui: { notify: (msg: string) => notified.push(msg) },
  } as unknown as ExtensionCommandContext
  return { ctx, notified }
}

function mockPi(): {
  pi: ExtensionAPI
  commands: Map<
    string,
    { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
  >
} {
  const commands = new Map<
    string,
    { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
  >()
  const pi = {
    registerCommand: (
      name: string,
      def: {
        description?: string
        handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>
      },
    ) => {
      commands.set(name, def)
    },
  } as ExtensionAPI
  return { pi, commands }
}

let tempDir: string
let accountPath: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pi-commands-test-'))
  accountPath = join(tempDir, 'anthropic-auth.json')
  process.env[ENV_KEY] = accountPath
  process.env[CACHEKEEP_REGISTRY_ENV_KEY] = join(tempDir, 'cachekeep-registry')
})

afterEach(async () => {
  delete process.env[ENV_KEY]
  delete process.env[CACHEKEEP_REGISTRY_ENV_KEY]
  await rm(tempDir, { recursive: true, force: true })
})

describe('claude-account persistence', () => {
  test('disable persists to storage', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: 'a1',
            label: 'One',
            type: 'oauth',
            access: 'tok',
            refresh: 'rtok',
            enabled: true,
            addedAt: 1,
          },
          {
            id: 'a2',
            label: 'Two',
            type: 'api',
            baseURL: 'https://api.example.com',
            authHeader: 'authorization-bearer',
            enabled: true,
            addedAt: 2,
          },
        ],
      }),
      'utf8',
    )

    const { pi, commands } = mockPi()
    registerCommands(pi)

    const handler = commands.get('claude-account')?.handler
    expect(handler).toBeDefined()

    const { ctx, notified } = mockNotify()
    await handler!('disable a2', ctx)

    expect(notified[0] ?? '').toInclude('disabled')
    expect(notified[0] ?? '').toInclude('Two')

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    const account = storage.accounts.find((a: { id: string }) => a.id === 'a2')
    expect(account.enabled).toBe(false)
  })

  test('remove persists to storage', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: 'a1',
            label: 'One',
            type: 'oauth',
            access: 'tok',
            refresh: 'rtok',
            enabled: true,
            addedAt: 1,
          },
          {
            id: 'a2',
            label: 'Two',
            type: 'api',
            baseURL: 'https://api.example.com',
            authHeader: 'authorization-bearer',
            enabled: true,
            addedAt: 2,
          },
        ],
      }),
      'utf8',
    )

    const { pi, commands } = mockPi()
    registerCommands(pi)

    const handler = commands.get('claude-account')?.handler
    expect(handler).toBeDefined()

    const { ctx, notified } = mockNotify()
    await handler!('remove a2', ctx)

    expect(notified[0] ?? '').toInclude('removed')
    expect(notified[0] ?? '').toInclude('Two')

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.accounts).toHaveLength(1)
    expect(storage.accounts[0].id).toBe('a1')
  })

  test('enable persists to storage', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        accounts: [
          {
            id: 'a1',
            label: 'One',
            type: 'oauth',
            access: 'tok',
            refresh: 'rtok',
            enabled: false,
            addedAt: 1,
          },
        ],
      }),
      'utf8',
    )

    const { pi, commands } = mockPi()
    registerCommands(pi)

    const handler = commands.get('claude-account')?.handler
    expect(handler).toBeDefined()

    const { ctx } = mockNotify()
    await handler!('enable a1', ctx)

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.accounts[0].enabled).toBe(true)
  })

  test('status is display-only (no mutation)', async () => {
    const original = {
      version: 1,
      accounts: [
        {
          id: 'a1',
          label: 'One',
          type: 'oauth',
          access: 'tok',
          refresh: 'rtok',
          enabled: true,
          addedAt: 1,
        },
      ],
    }
    await writeFile(accountPath, JSON.stringify(original), 'utf8')

    const { pi, commands } = mockPi()
    registerCommands(pi)

    const handler = commands.get('claude-account')?.handler
    expect(handler).toBeDefined()

    const { ctx, notified } = mockNotify()
    await handler!('', ctx)

    expect(notified[0] ?? '').toInclude('Claude Accounts')
    expect(notified[0] ?? '').toInclude('One')

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage).toEqual(original)
  })
})

describe('claude-logging persistence', () => {
  test('sets log level and persists', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({ version: 1, accounts: [] }),
      'utf8',
    )

    const { pi, commands } = mockPi()
    registerCommands(pi)

    const handler = commands.get('claude-logging')?.handler
    expect(handler).toBeDefined()

    const { ctx, notified } = mockNotify()
    await handler!('debug', ctx)

    expect(notified[0] ?? '').toInclude('debug')

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.logging?.level).toBe('debug')
  })

  test('status shows current level without mutating', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        accounts: [],
        logging: { level: 'warn' },
      }),
      'utf8',
    )

    const { pi, commands } = mockPi()
    registerCommands(pi)

    const handler = commands.get('claude-logging')?.handler
    expect(handler).toBeDefined()

    const { ctx, notified } = mockNotify()
    await handler!('', ctx)

    expect(notified[0] ?? '').toInclude('warn')

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.logging?.level).toBe('warn')
  })
})

describe('claude-cachekeep status', () => {
  test('lists tracked sessions from all live Pi instances', async () => {
    const registryDirectory = process.env[CACHEKEEP_REGISTRY_ENV_KEY]
    if (!registryDirectory)
      throw new Error('missing cachekeep registry directory')
    const registry = new CacheKeepSessionRegistry({
      directory: registryDirectory,
      instanceId: 'other-pi-instance',
    })
    const cacheExpiresAt = Date.now() + 60 * 60_000
    await registry.publish([
      {
        id: 'pi-session-1',
        cacheExpiresAt,
        nextPrewarmAt: cacheExpiresAt - 5 * 60_000,
      },
    ])

    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        accounts: [],
        claudeCache: { enabled: true, mode: 'hybrid' },
        cacheKeep: { enabled: true, startHour: 0, endHour: 23 },
      }),
      'utf8',
    )
    const { pi, commands } = mockPi()
    registerCommands(pi)
    const handler = commands.get('claude-cachekeep')?.handler
    expect(handler).toBeDefined()

    const { ctx, notified } = mockNotify()
    await handler!('', ctx)

    expect(notified[0]).toContain('Tracked sessions: 1')
    expect(notified[0]).toContain('Sessions:\n- pi-session-1')
  })
})
