/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { E2EHarness } from '../src/harness.ts'

let harness: E2EHarness | null = null

afterEach(async () => {
  await harness?.dispose()
  harness = null
})

describe('quota headers through relay', () => {
  it('keeps quota harvest direct-only when relay transport is configured', async () => {
    harness = await E2EHarness.create({ relay: 'websocket' })
    harness.script([
      {
        type: 'text',
        text: 'relay response',
        headers: {
          'anthropic-ratelimit-unified-representative-claim': 'five_hour',
          'anthropic-ratelimit-unified-5h-utilization': '0.78',
          'anthropic-ratelimit-unified-5h-reset': '1784246400',
          'anthropic-ratelimit-unified-7d-utilization': '0.4',
          'anthropic-ratelimit-unified-7d-reset': '1784628000',
          'anthropic-ratelimit-unified-fallback': 'available',
        },
      },
    ])

    const sessionId = await harness.createSession()
    await harness.sendPrompt(sessionId, 'return the relay response')
    await harness.waitFor(() => (harness?.relay?.acceptedRequests() ?? 0) >= 1, {
      label: 'relay request accepted',
    })

    const statePath = join(
      harness.opencode.env.configDir,
      'anthropic-auth-state.json',
    )
    const state = await readFile(statePath, 'utf8')
      .then((value) => JSON.parse(value))
      .catch(() => null)

    expect(state?.main?.quota?.source).not.toBe('headers')
    expect(state?.main?.quota?.five_hour?.usedPercent).not.toBe(78)
  }, 90_000)
})
