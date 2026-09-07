/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SubcClient } from '@cortexkit/subc-client'
import { startFakeClaustrumDaemon } from '../src/mock-claustrum.ts'

const roots: string[] = []
const daemons: Array<{ stop: () => Promise<void> }> = []
const clients: Array<{ close: () => void }> = []

afterEach(async () => {
  for (const client of clients.splice(0)) client.close()
  await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('fake Claustrum daemon', () => {
  it('serves a credential payload through the Subc wire protocol', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anthropic-auth-e2e-claustrum-'))
    roots.push(root)
    const daemon = await startFakeClaustrumDaemon({
      directory: root,
      credentials: {
        'ckh_main': {
          payload: JSON.stringify({ access_token: 'vault-main' }),
          account_id: 'account-main',
          record_version: 7,
          expires_at_ms: Date.now() + 60 * 60 * 1000,
        },
      },
    })
    daemons.push(daemon)
    const client = await SubcClient.connect({
      connectionFile: daemon.connectionFile,
      identity: { project_root: root, harness: 'e2e', session: 'fixture-smoke' },
    })
    clients.push(client)

    const response = await client.call('claustrum', 'credential.get', {
      handle: 'ckh_main',
      force_refresh: false,
      min_ttl_ms: 0,
    })

    expect(response).toEqual({
      result: {
        payload: Array.from(new TextEncoder().encode('{"access_token":"vault-main"}')),
        account_id: 'account-main',
        record_version: 7,
        expires_at_ms: expect.any(Number),
      },
    })
  })
})
