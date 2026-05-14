/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from 'bun:test'
import { E2EHarness } from '../src/harness.ts'

let harness: E2EHarness | null = null

afterEach(async () => {
  await harness?.dispose()
  harness = null
})

describe('OpenCode Anthropic auth e2e', () => {
  it('strips mcp_ tool names even when Anthropic SSE chunks split the name field', async () => {
    harness = await E2EHarness.create()
    harness.script([
      {
        type: 'tool_use',
        name: 'mcp_Read',
        input: { filePath: harness.sampleFilePath() },
        splitToolNameChunk: true,
      },
      { type: 'text', text: 'read complete' },
    ])

    const sessionId = await harness.createSession()
    const result = await harness.sendPrompt(sessionId, 'read sample.txt')

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('unavailable tool')
    expect(serialized).not.toContain('mcp_Read')
    await harness.waitFor(
      () => harness!.anthropic.requests().length >= 2,
      { label: 'tool call and follow-up request captured' },
    )
    expect(
      harness.anthropic.requests().some((request) =>
        JSON.stringify(request.body).includes('hello from sample file'),
      ),
    ).toBe(true)
  }, 90_000)

  it('streams through websocket relay without closing before response', async () => {
    harness = await E2EHarness.create({ relay: 'websocket' })
    harness.script([{ type: 'text', text: 'relay ok' }])

    const sessionId = await harness.createSession()
    const result = await harness.sendPrompt(sessionId, 'hello via relay')

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('websocket closed')
    await harness.waitFor(() => (harness!.relay?.acceptedRequests() ?? 0) >= 1, {
      label: 'websocket relay accepted request',
    })
    await harness.waitFor(() => harness!.anthropic.requests().length >= 1, {
      label: 'upstream request captured',
    })
  }, 90_000)
})
