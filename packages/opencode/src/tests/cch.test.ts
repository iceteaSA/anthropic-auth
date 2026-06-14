import { describe, expect, test } from 'bun:test'
import {
  buildBillingHeaderValue,
  computeCCH,
  computeVersionSuffix,
  extractFirstUserMessageText,
  signRequestBody,
} from '@cortexkit/anthropic-auth-core'

describe('billing header helpers', () => {
  test('extracts text from the first user message', () => {
    expect(
      extractFirstUserMessageText([
        { role: 'assistant', content: 'ignore me' },
        {
          role: 'user',
          content: [
            { type: 'image', text: 'ignored' },
            { type: 'text', text: 'hello world test message' },
          ],
        },
      ]),
    ).toBe('hello world test message')
  })

  test('computes the 5-character body cch hash', async () => {
    expect(
      await computeCCH(new TextEncoder().encode('hello world test message')),
    ).toBe('5236e')
  })

  test('computes the captured Claude Code build suffix for the default version', () => {
    expect(computeVersionSuffix('2.1.177', new Date('2026-04-29'))).toBe('3bf')
  })

  test('keeps custom version suffixes stable across date boundaries', () => {
    expect(computeVersionSuffix('2.1.87', new Date('2026-04-29'))).toBe(
      computeVersionSuffix('2.1.87', new Date('2026-04-30')),
    )
  })

  test('signs serialized request body cch placeholder', async () => {
    const body = JSON.stringify({
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.87.623; cc_entrypoint=sdk-cli; cch=00000;',
        },
      ],
    })

    expect(await signRequestBody(body)).toContain('cch=59353;')
  })

  test('signs only the billing header cch and leaves message history unchanged', async () => {
    const historyText = 'historical debug content: cch=abcde; cch=00000;'
    const body = JSON.stringify({
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: historyText }],
        },
      ],
      system: [
        {
          type: 'text',
          text: 'x-anthropic-billing-header: cc_version=2.1.87.623; cc_entrypoint=sdk-cli; cch=00000;',
        },
      ],
    })

    const signed = await signRequestBody(body)
    const parsed = JSON.parse(signed)

    expect(parsed.messages[0].content[0].text).toBe(historyText)
    expect(parsed.system[0].text).toMatch(/cch=[0-9a-f]{5};$/)
    expect(parsed.system[0].text).not.toContain('cch=00000;')
  })

  test('builds the full billing header value', () => {
    expect(
      buildBillingHeaderValue(
        [{ role: 'user', content: 'hello world test message' }],
        '2.1.87',
        'sdk-cli',
        new Date('2026-04-29'),
      ),
    ).toBe(
      'x-anthropic-billing-header: cc_version=2.1.87.398; cc_entrypoint=sdk-cli; cch=00000;',
    )
  })
})
