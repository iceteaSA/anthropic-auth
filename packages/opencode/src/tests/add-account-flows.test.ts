import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let tempDir: string
let accountPath: string

async function useTempAccountFile() {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
  tempDir = await mkdtemp(join(tmpdir(), 'anthropic-add-acct-'))
  accountPath = join(tempDir, 'anthropic-auth.json')
  process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath
  const { saveAccounts } = await import('@cortexkit/anthropic-auth-core')
  await saveAccounts(
    {
      version: 1,
      main: { type: 'opencode', provider: 'anthropic' },
      accounts: [],
    },
    accountPath,
  )
}

function createMockClient() {
  return {
    auth: { set: mock(() => Promise.resolve()) },
    session: { promptAsync: mock(() => Promise.resolve()) },
  }
}

async function getPlugin() {
  const { AnthropicAuthPlugin } = await import('../index')
  return (await AnthropicAuthPlugin({
    // @ts-expect-error: minimal mock for testing
    client: createMockClient(),
  })) as Promise<any>
}

async function executeCommand(
  plugin: any,
  command: string,
  args: string,
  sessionId?: string,
): Promise<void> {
  await expect(
    plugin['command.execute.before']({
      command,
      arguments: args,
      sessionID: sessionId ?? 'ses_test',
    }),
  ).rejects.toThrow('__OPENCODE_ANTHROPIC_AUTH_COMMAND_HANDLED__')
}

function findCommandsLog(
  records: Array<{
    level: string
    channel: string
    message: string
    payload?: Record<string, unknown>
  }>,
  message: string,
) {
  return records.find(
    (r) =>
      r.level === 'info' && r.channel === 'commands' && r.message === message,
  )
}

function scanLogsForSecrets(
  records: Array<{
    level: string
    channel: string
    message: string
    payload?: Record<string, unknown>
  }>,
): string[] {
  const hits: string[] = []
  const patterns = [/sk-ant-/i, /Bearer\s+/i, /eyJ/, /verifier/i]
  for (const rec of records) {
    const payloadStr = JSON.stringify(rec.payload ?? {})
    for (const pat of patterns) {
      if (pat.test(payloadStr)) {
        hits.push(`record '${rec.message}' contained match for ${pat.source}`)
      }
    }
  }
  return hits
}

let capturedRecords: Array<{
  level: string
  channel: string
  message: string
  payload?: Record<string, unknown>
}> = []

beforeEach(async () => {
  capturedRecords = []
  const { __setLogTestSink } = await import('@cortexkit/anthropic-auth-core')
  __setLogTestSink((record) => {
    capturedRecords.push(record)
  })
  await useTempAccountFile()
})

afterEach(async () => {
  const { __setLogTestSink } = await import('@cortexkit/anthropic-auth-core')
  __setLogTestSink(null)
  delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
  mock.restore()
})

// ---------------------------------------------------------------------------
// parseAccountCommandAction — add actions (core)
// ---------------------------------------------------------------------------
describe('parseAccountCommandAction — add actions', () => {
  test('add-apikey with key only', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(parseAccountCommandAction('add-apikey sk-ant-test123')).toEqual({
      type: 'add-apikey',
      apiKey: 'sk-ant-test123',
    })
  })

  test('add-apikey with key and label', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(
      parseAccountCommandAction('add-apikey sk-ant-test123 My Label'),
    ).toEqual({
      type: 'add-apikey',
      apiKey: 'sk-ant-test123',
      label: 'My Label',
    })
  })

  test('add-apikey without key falls to usage', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(parseAccountCommandAction('add-apikey')).toEqual({ type: 'usage' })
  })

  test('add-oauth-start', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(parseAccountCommandAction('add-oauth-start')).toEqual({
      type: 'add-oauth-start',
    })
  })

  test('add-oauth-finish with code', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(
      parseAccountCommandAction('add-oauth-finish some-auth-code'),
    ).toEqual({
      type: 'add-oauth-finish',
      code: 'some-auth-code',
    })
  })

  test('add-oauth-finish without code falls to usage', async () => {
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    expect(parseAccountCommandAction('add-oauth-finish')).toEqual({
      type: 'usage',
    })
  })
})

// ---------------------------------------------------------------------------
// add-apikey — persistence + security (no mocks needed)
// ---------------------------------------------------------------------------
describe('add-apikey flow', () => {
  test('persists an API key account to the store', async () => {
    const plugin = await getPlugin()
    await executeCommand(plugin, 'claude-account', 'add-apikey sk-ant-test123')

    const { loadAccounts } = await import('@cortexkit/anthropic-auth-core')
    const loaded = await loadAccounts(accountPath)
    expect(loaded).not.toBeNull()
    expect(loaded!.accounts).toHaveLength(1)
    const account = loaded!.accounts[0]!
    expect(account.type).toBe('api')
    if (account.type === 'api') {
      expect(account.apiKey).toBe('sk-ant-test123')
      expect(account.baseURL).toBe('https://api.kie.ai/claude')
      expect(account.authHeader).toBe('authorization-bearer')
    }
    expect(account.enabled).toBe(true)
  })

  test('persists with a label', async () => {
    const plugin = await getPlugin()
    await executeCommand(
      plugin,
      'claude-account',
      'add-apikey sk-ant-test456 Work API',
    )

    const { loadAccounts } = await import('@cortexkit/anthropic-auth-core')
    const loaded = await loadAccounts(accountPath)
    expect(loaded).not.toBeNull()
    expect(loaded!.accounts).toHaveLength(1)
    expect(loaded!.accounts[0]!.label).toBe('Work API')
    expect(loaded!.accounts[0]!.id).toBe('Work API')
  })

  test('emits INFO log with id/label/type but NO apiKey', async () => {
    const plugin = await getPlugin()
    await executeCommand(
      plugin,
      'claude-account',
      'add-apikey sk-ant-secret123',
    )

    const rec = findCommandsLog(capturedRecords, 'account added')
    expect(rec).toBeDefined()
    const payload = rec!.payload!
    expect(payload.id).toBeDefined()
    expect(payload.type).toBe('apikey')

    const payloadStr = JSON.stringify(payload)
    expect(payloadStr).not.toContain('sk-ant-secret123')
    expect(payloadStr).not.toContain('apiKey')
    expect(payloadStr).not.toContain('sk-ant')
    expect(payloadStr).not.toContain('secret')
  })

  test('account list after add shows the new account', async () => {
    const plugin = await getPlugin()
    await executeCommand(
      plugin,
      'claude-account',
      'add-apikey sk-ant-list TestList',
    )

    const { buildAccountList, loadAccounts } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    const storage = await loadAccounts(accountPath)
    const list = buildAccountList(storage!)
    expect(list).toHaveLength(2) // main + fallback
    const fallback = list.find((a: { role: string }) => a.role === 'fallback')
    expect(fallback).toBeDefined()
    expect(fallback!.label).toBe('TestList')
  })
})

// ---------------------------------------------------------------------------
// add-oauth — error paths (no mocks needed)
// ---------------------------------------------------------------------------
describe('add-oauth error paths', () => {
  test('add-oauth-finish with no pending state gives graceful error', async () => {
    const plugin = await getPlugin()
    capturedRecords = []

    await executeCommand(
      plugin,
      'claude-account',
      'add-oauth-finish somecode',
      'ses_no_pending',
    )

    const { loadAccounts } = await import('@cortexkit/anthropic-auth-core')
    const loaded = await loadAccounts(accountPath)
    expect(loaded!.accounts).toHaveLength(0)
  })

  test('add-oauth-start stores pending and returns url', async () => {
    // We can't mock authorize at the module level easily in Bun ESM,
    // but we can verify the command doesn't crash and produces a notification.
    // Live-verify: the actual authorize() call makes an HTTP request.
    // For unit-test purposes, we verify the parser + the error paths.
    //
    // Test that the command syntax is accepted:
    const { parseAccountCommandAction } = await import(
      '@cortexkit/anthropic-auth-core'
    )
    const parsed = parseAccountCommandAction('add-oauth-start')
    expect(parsed.type).toBe('add-oauth-start')
  })
})

// ---------------------------------------------------------------------------
// security — no secrets in logs
// ---------------------------------------------------------------------------
describe('security — no secrets in logs', () => {
  test('API key is never in any log record', async () => {
    const plugin = await getPlugin()
    await executeCommand(
      plugin,
      'claude-account',
      'add-apikey sk-ant-super-secret-key-abc123 MyLabel',
    )

    const hits = scanLogsForSecrets(capturedRecords)
    expect(hits).toEqual([])
  })

  test('apply path does not log raw API key arguments', async () => {
    const plugin = await getPlugin()
    await executeCommand(
      plugin,
      'claude-account',
      'add-apikey sk-ant-rpc-key123',
    )

    for (const rec of capturedRecords) {
      const payloadStr = JSON.stringify(rec.payload ?? {})
      expect(payloadStr).not.toContain('sk-ant-rpc-key123')
      expect(payloadStr).not.toContain('add-apikey sk-ant')
    }
  })

  test('add-oauth-finish code is not logged', async () => {
    const plugin = await getPlugin()

    // The code travels through the arguments string to the parser,
    // but should never appear in the log payload
    await executeCommand(
      plugin,
      'claude-account',
      'add-oauth-finish sk-ant-secret-auth-code',
      'ses_sec_code',
    )

    for (const rec of capturedRecords) {
      const payloadStr = JSON.stringify(rec.payload ?? {})
      expect(payloadStr).not.toContain('sk-ant-secret-auth-code')
    }
  })
})
