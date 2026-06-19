import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAccountStatePath } from '@cortexkit/anthropic-auth-core'

import { relaySetup } from '../cli'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let tempDir: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'anthropic-cli-test-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('CLI api add', () => {
  test('saves API route config and stores API key in runtime state', async () => {
    const accountPath = join(tempDir, 'anthropic-auth.json')
    const proc = Bun.spawn(['bun', 'src/cli.ts', 'api', 'add', 'kie-opus'], {
      cwd: packageRoot,
      env: {
        ...process.env,
        OPENCODE_ANTHROPIC_AUTH_FILE: accountPath,
        OPENCODE_ANTHROPIC_AUTH_API_BASE_URL: 'https://api.kie.ai/claude',
        OPENCODE_ANTHROPIC_AUTH_API_KEY: 'kie-key',
        OPENCODE_ANTHROPIC_AUTH_API_AUTH_HEADER: 'authorization-bearer',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Saved API fallback route "kie-opus"')

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.accounts[0]).toMatchObject({
      id: 'kie-opus',
      label: 'kie-opus',
      type: 'api',
      enabled: true,
      baseURL: 'https://api.kie.ai/claude',
      authHeader: 'authorization-bearer',
    })
    expect(storage.accounts[0].apiKey).toBeUndefined()

    const runtimeState = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    )
    expect(runtimeState.accounts['kie-opus'].apiKey).toBe('kie-key')
  })

  test('rejects invalid API base URL before saving route state', async () => {
    const accountPath = join(tempDir, 'anthropic-auth.json')
    const proc = Bun.spawn(['bun', 'src/cli.ts', 'api', 'add', 'bad-api'], {
      cwd: packageRoot,
      env: {
        ...process.env,
        OPENCODE_ANTHROPIC_AUTH_FILE: accountPath,
        OPENCODE_ANTHROPIC_AUTH_API_BASE_URL: 'https://secret@example.com/v1',
        OPENCODE_ANTHROPIC_AUTH_API_KEY: 'kie-key',
        OPENCODE_ANTHROPIC_AUTH_API_AUTH_HEADER: 'authorization-bearer',
      },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ])

    expect(exitCode).toBe(1)
    expect(stderr).toContain('API fallback base URL must be an http(s) URL')
  })
})

describe('CLI login', () => {
  test('continues from label prompt to OAuth callback prompt and saves account', async () => {
    const accountPath = join(tempDir, 'anthropic-auth.json')
    const preloadPath = join(tempDir, 'preload.ts')

    await writeFile(
      preloadPath,
      `globalThis.fetch = async () => new Response(JSON.stringify({ access_token: 'cli-access', refresh_token: 'cli-refresh', expires_in: 3600 }), { status: 200 })\n`,
      'utf8',
    )

    const proc = Bun.spawn(
      ['bun', '--preload', preloadPath, 'src/cli.ts', 'login'],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          OPENCODE_ANTHROPIC_AUTH_FILE: accountPath,
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let stdout = ''
    let state: string | undefined

    proc.stdin.write('cli-label\n')

    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      stdout += decoder.decode(chunk.value, { stream: true })
      state = stdout.match(/[?&]state=([a-f0-9]+)/)?.[1]
      if (state) break
    }

    expect(state).toBeString()

    proc.stdin.write(
      `https://platform.claude.com/oauth/code/callback?code=cli-code&state=${state}\n`,
    )
    proc.stdin.end()

    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      stdout += decoder.decode(chunk.value, { stream: true })
    }

    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ])

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Paste the full callback URL')
    expect(stdout).toContain('Saved fallback account "cli-label"')

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.accounts).toHaveLength(1)
    expect(storage.accounts[0]).toMatchObject({
      id: 'cli-label',
      label: 'cli-label',
      enabled: true,
    })
    expect(storage.accounts[0].access).toBeUndefined()
    expect(storage.accounts[0].refresh).toBeUndefined()

    const runtimeState = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    )
    expect(runtimeState.accounts['cli-label']).toMatchObject({
      access: 'cli-access',
      refresh: 'cli-refresh',
    })
  })

  test('re-login with same label clears stale errors and quota', async () => {
    const accountPath = join(tempDir, 'anthropic-auth.json')
    const preloadPath = join(tempDir, 'preload.ts')

    await writeFile(
      accountPath,
      JSON.stringify({
        version: 1,
        main: { type: 'opencode', provider: 'anthropic' },
        accounts: [
          {
            id: 'cli-label',
            label: 'cli-label',
            type: 'oauth',
            access: 'old-access',
            refresh: 'old-refresh',
            expires: 1,
            enabled: true,
            addedAt: 123,
            quota: {
              five_hour: {
                usedPercent: 99,
                remainingPercent: 1,
                checkedAt: 123,
              },
            },
            lastRefreshedAt: 123,
            lastRefreshError: { message: 'old refresh failed', checkedAt: 123 },
            lastQuotaRefreshError: {
              message: 'old quota failed',
              checkedAt: 123,
            },
          },
        ],
      }),
      'utf8',
    )
    await writeFile(
      preloadPath,
      `globalThis.fetch = async () => new Response(JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }), { status: 200 })\n`,
      'utf8',
    )

    const proc = Bun.spawn(
      ['bun', '--preload', preloadPath, 'src/cli.ts', 'login', 'cli-label'],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          OPENCODE_ANTHROPIC_AUTH_FILE: accountPath,
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )

    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    let stdout = ''
    let state: string | undefined

    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      stdout += decoder.decode(chunk.value, { stream: true })
      state = stdout.match(/[?&]state=([a-f0-9]+)/)?.[1]
      if (state) break
    }

    expect(state).toBeString()

    proc.stdin.write(
      `https://platform.claude.com/oauth/code/callback?code=cli-code&state=${state}\n`,
    )
    proc.stdin.end()

    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      stdout += decoder.decode(chunk.value, { stream: true })
    }

    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
    ])

    expect(stderr).toBe('')
    expect(exitCode).toBe(0)

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.accounts).toHaveLength(1)
    expect(storage.accounts[0]).toMatchObject({
      id: 'cli-label',
      label: 'cli-label',
      enabled: true,
      addedAt: 123,
    })
    expect(storage.accounts[0].access).toBeUndefined()
    expect(storage.accounts[0].refresh).toBeUndefined()
    expect(storage.accounts[0].quota).toBeUndefined()
    expect(storage.accounts[0].lastRefreshedAt).toBeUndefined()
    expect(storage.accounts[0].lastRefreshError).toBeUndefined()
    expect(storage.accounts[0].lastQuotaRefreshError).toBeUndefined()

    const runtimeState = JSON.parse(
      await readFile(getAccountStatePath(accountPath), 'utf8'),
    )
    expect(runtimeState.accounts['cli-label']).toMatchObject({
      access: 'new-access',
      refresh: 'new-refresh',
    })
    expect(runtimeState.accounts['cli-label'].quota).toBeUndefined()
    expect(runtimeState.accounts['cli-label'].lastRefreshedAt).toBeUndefined()
    expect(runtimeState.accounts['cli-label'].lastRefreshError).toBeUndefined()
    expect(
      runtimeState.accounts['cli-label'].lastQuotaRefreshError,
    ).toBeUndefined()
  })
})

describe('CLI relay setup', () => {
  // relaySetup is exercised IN-PROCESS with an injected fetch + prompt rather
  // than via `bun --preload ... src/cli.ts relay setup`. The old subprocess
  // form hung indefinitely in CI (timed out at 5000ms with proc.exited never
  // resolving) — the failure lived in the subprocess+--preload+readline/stdin
  // harness, not in relaySetup's logic, and was unreproducible locally. Calling
  // relaySetup directly with injected deps removes that entire fragile surface
  // (no spawn, no preload-stub-application risk, no real network, no stdin/pipe
  // race) while still exercising the real setup logic: KV create, worker
  // upload, enable workers.dev, subdomain lookup, token generation, and config
  // save — the same four Cloudflare calls and the same persisted relay config.
  test('deploys worker resources and saves relay config', async () => {
    const accountPath = join(tempDir, 'anthropic-auth.json')
    const calls: Array<{ url: string; method?: string }> = []

    const fetchImpl = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = input.toString()
      calls.push({ url, method: init?.method })
      if (url.includes('/storage/kv/namespaces'))
        return Response.json({ success: true, result: { id: 'kv-id' } })
      if (url.includes('/workers/scripts/opencode-anthropic-relay/subdomain'))
        return Response.json({ success: true, result: { enabled: true } })
      if (url.includes('/workers/subdomain'))
        return Response.json({
          success: true,
          result: { subdomain: 'user-subdomain' },
        })
      if (url.includes('/workers/scripts/opencode-anthropic-relay'))
        return Response.json({ success: true, result: {} })
      return Response.json(
        { success: false, errors: [{ message: `unexpected ${url}` }] },
        { status: 500 },
      )
    }

    // The worker-name prompt returns '' (→ default name); no other prompt fires
    // because the injected fetch returns a workers.dev subdomain.
    const promptAnswers: Record<string, string> = {
      'Worker name [opencode-anthropic-relay]: ': '',
    }
    const askedPrompts: string[] = []
    const prompt = async (message: string) => {
      askedPrompts.push(message)
      return promptAnswers[message] ?? ''
    }

    const prevFile = process.env.OPENCODE_ANTHROPIC_AUTH_FILE
    const prevToken = process.env.CLOUDFLARE_API_TOKEN
    const prevAccount = process.env.CLOUDFLARE_ACCOUNT_ID
    process.env.OPENCODE_ANTHROPIC_AUTH_FILE = accountPath
    process.env.CLOUDFLARE_API_TOKEN = 'cf-token'
    process.env.CLOUDFLARE_ACCOUNT_ID = 'account-id'
    try {
      await relaySetup({ fetchImpl, prompt })
    } finally {
      if (prevFile === undefined)
        delete process.env.OPENCODE_ANTHROPIC_AUTH_FILE
      else process.env.OPENCODE_ANTHROPIC_AUTH_FILE = prevFile
      if (prevToken === undefined) delete process.env.CLOUDFLARE_API_TOKEN
      else process.env.CLOUDFLARE_API_TOKEN = prevToken
      if (prevAccount === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID
      else process.env.CLOUDFLARE_ACCOUNT_ID = prevAccount
    }

    // Token + account come from env, so the only prompt is the worker name.
    expect(askedPrompts).toEqual(['Worker name [opencode-anthropic-relay]: '])

    const storage = JSON.parse(await readFile(accountPath, 'utf8'))
    expect(storage.relay).toMatchObject({
      enabled: true,
      url: 'https://opencode-anthropic-relay.user-subdomain.workers.dev',
      fallbackToDirect: true,
      transport: 'http',
    })
    expect(storage.relay.token).toBeString()

    expect(calls).toHaveLength(4)
    expect(calls.map((c) => `${c.method ?? 'GET'} ${c.url}`)).toEqual([
      'POST https://api.cloudflare.com/client/v4/accounts/account-id/storage/kv/namespaces',
      'PUT https://api.cloudflare.com/client/v4/accounts/account-id/workers/scripts/opencode-anthropic-relay',
      'POST https://api.cloudflare.com/client/v4/accounts/account-id/workers/scripts/opencode-anthropic-relay/subdomain',
      'GET https://api.cloudflare.com/client/v4/accounts/account-id/workers/subdomain',
    ])
  })
})
