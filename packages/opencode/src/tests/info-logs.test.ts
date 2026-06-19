import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AccountStorage,
  saveAccounts,
} from '@cortexkit/anthropic-auth-core'
import { AnthropicAuthPlugin } from '../index'

function createFallbackStorage(): AccountStorage {
  return {
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
  }
}

let tempConfigDir: string

async function useTempAccountFile(storage: AccountStorage) {
  if (tempConfigDir) {
    await rm(tempConfigDir, { recursive: true, force: true }).catch(() => {})
  }
  tempConfigDir = await mkdtemp(join(tmpdir(), 'anthropic-info-logs-test-'))
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = join(
    tempConfigDir,
    'anthropic-auth.json',
  )
  await saveAccounts(storage)
}

function createMockClient() {
  return {
    auth: { set: mock(() => Promise.resolve()) },
    session: {
      promptAsync: mock(() => Promise.resolve()),
    },
  }
}

async function getPlugin() {
  return (await AnthropicAuthPlugin({
    // @ts-expect-error: minimal mock for testing
    client: createMockClient(),
  })) as Promise<any>
}

afterEach(async () => {
  delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  if (tempConfigDir) {
    await rm(tempConfigDir, { recursive: true, force: true }).catch(() => {})
  }
})

async function executeCommand(
  plugin: any,
  command: string,
  args: string,
): Promise<void> {
  await expect(
    plugin['command.execute.before']({
      command,
      arguments: args,
      sessionID: 'ses_test',
    }),
  ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
}

async function readConfigFile(): Promise<any> {
  return JSON.parse(
    await readFile(process.env.OPENCODE_ANTHROPIC_AUTH_FILE!, 'utf8'),
  )
}

describe('setting-change INFO logs (side-effect verification)', () => {
  test('dump enable persists setting on change path', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-dump', 'on')
    const raw = await readConfigFile()
    expect(raw.dump?.enabled).toBe(true)
  })

  test('fast mode enable persists setting on change path', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-fast', 'on')
    const raw = await readConfigFile()
    expect(raw.claudeFast?.enabled).toBe(true)
  })

  test('routing mode change persists setting on change path', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-routing', 'fallback-first')
    const raw = await readConfigFile()
    expect(raw.routing?.mode).toBe('fallback-first')
  })

  test('cache enable persists setting on change path', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-cache', 'on')
    const raw = await readConfigFile()
    expect(raw.claudeCache?.enabled).toBe(true)
  })

  test('cache mode change persists setting on change path', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-cache', 'mode hybrid')
    const raw = await readConfigFile()
    expect(raw.claudeCache?.mode).toBe('hybrid')
  })

  test('killswitch enable persists setting on change path', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-killswitch', 'on')
    const raw = await readConfigFile()
    expect(raw.killswitch?.enabled).toBe(true)
  })

  test('killswitch thresholds persist on change path', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-killswitch', 'set main:3,8')
    const raw = await readConfigFile()
    expect(raw.killswitch?.enabled).toBe(true)
    expect(raw.killswitch?.main?.five_hour).toBe(3)
    expect(raw.killswitch?.main?.seven_day).toBe(8)
  })

  test('status-only commands do not mutate storage', async () => {
    await useTempAccountFile(createFallbackStorage())
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-dump', '')
    const raw = await readConfigFile()
    expect(raw.dump?.enabled).toBeUndefined()
  })
})
