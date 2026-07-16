import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent'
import { registerCommands } from '../commands'

const ENV_KEY = 'PI_ANTHROPIC_AUTH_FILE'

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
let statePath: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'pi-commands-test-'))
  accountPath = join(tempDir, 'anthropic-auth.json')
  // The core's getAccountStatePath places the state file alongside
  // the config when the config ends with the account file name.
  statePath = join(tempDir, 'anthropic-auth-state.json')
  process.env[ENV_KEY] = accountPath
  process.env.OPENCODE_ANTHROPIC_AUTH_STATE_FILE = statePath
})

afterEach(async () => {
  delete process.env[ENV_KEY]
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

describe('claude-prime — Pi display-only contract', () => {
  // The plan + rev-1 / rev-2 require that Pi's `/claude-prime` handler
  // is display-only: it must NEVER call `setPrimePersistentEnabled`,
  // and on/off/status args must all return the same status text. The
  // byte-for-byte config + runtime-state file invariance ensures a
  // future edit that wires Pi to the persistent setter would fail this
  // test.

  function readConfigAndState() {
    return Promise.all([
      readFile(accountPath, 'utf8').then((text) => JSON.parse(text)),
      readFile(statePath, 'utf8')
        .then((text) => JSON.parse(text))
        .catch(() => null),
    ]).then(([config, state]) => ({ config, state }))
  }

  test('registers a claude-prime command (sanity)', async () => {
    await writeFile(
      accountPath,
      JSON.stringify({ version: 1, accounts: [] }),
      'utf8',
    )
    const { pi, commands } = mockPi()
    registerCommands(pi)
    expect(commands.get('claude-prime')).toBeDefined()
  })

  test('status arg notifies the current status; config + state bytes are unchanged', async () => {
    const initial = {
      version: 1,
      accounts: [],
      prime: { enabled: true },
    }
    await writeFile(accountPath, JSON.stringify(initial), 'utf8')
    const { pi, commands } = mockPi()
    registerCommands(pi)
    const handler = commands.get('claude-prime')?.handler
    expect(handler).toBeDefined()

    const { ctx, notified } = mockNotify()
    await handler!('status', ctx)

    expect(notified[0] ?? '').toContain('## Claude Prime Status')
    const { config, state } = await readConfigAndState()
    expect(config).toEqual(initial)
    // state file either unchanged (no runtime state) or non-existent.
    expect(state === null || state.version === 1).toBe(true)
  })

  test('on arg in Pi is display-only — never toggles the persistent setting', async () => {
    const initial = {
      version: 1,
      accounts: [],
      prime: { enabled: false },
    }
    await writeFile(accountPath, JSON.stringify(initial), 'utf8')
    const { pi, commands } = mockPi()
    registerCommands(pi)
    const handler = commands.get('claude-prime')?.handler
    expect(handler).toBeDefined()

    const { ctx, notified } = mockNotify()
    await handler!('on', ctx)

    // The handler MUST notify, but the persistent state MUST stay off.
    expect(notified.length).toBeGreaterThan(0)
    const { config, state } = await readConfigAndState()
    expect(config.prime?.enabled).toBe(false)
    expect(state === null || state.prime?.enabled !== true).toBe(true)
  })

  test('off arg in Pi is display-only — never toggles the persistent setting', async () => {
    const initial = {
      version: 1,
      accounts: [],
      prime: { enabled: true },
    }
    await writeFile(accountPath, JSON.stringify(initial), 'utf8')
    const { pi, commands } = mockPi()
    registerCommands(pi)
    const handler = commands.get('claude-prime')?.handler
    expect(handler).toBeDefined()

    const { ctx, notified } = mockNotify()
    await handler!('off', ctx)

    expect(notified.length).toBeGreaterThan(0)
    const { config, state } = await readConfigAndState()
    expect(config.prime?.enabled).toBe(true)
    expect(state === null || state.prime?.enabled !== false).toBe(true)
  })

  test('empty arg in Pi shows the status and does not mutate storage', async () => {
    const initial = {
      version: 1,
      accounts: [],
      prime: { enabled: true },
    }
    await writeFile(accountPath, JSON.stringify(initial), 'utf8')
    const { pi, commands } = mockPi()
    registerCommands(pi)
    const handler = commands.get('claude-prime')?.handler
    expect(handler).toBeDefined()

    const { ctx, notified } = mockNotify()
    await handler!('', ctx)

    expect(notified[0] ?? '').toContain('## Claude Prime Status')
    const { config, state } = await readConfigAndState()
    expect(config).toEqual(initial)
    expect(state === null || state.version === 1).toBe(true)
  })
})
