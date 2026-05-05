import { createHash } from 'node:crypto'
import xxhashInit from 'xxhash-wasm'
import { CLAUDE_CODE_VERSION } from './constants.ts'

type Message = {
  role?: string
  content?: string | Array<{ type?: string; text?: string }>
}

const CCH_SEED = 0x6e52736ac806831en
export const CCH_PATTERN = /\bcch=([0-9a-f]{5});/

let xxhashPromise: Promise<void> | null = null
let xxhash64Raw: ((input: Uint8Array, seed: bigint) => bigint) | null = null

async function ensureXxhash() {
  if (xxhash64Raw) return
  xxhashPromise ??= (async () => {
    const hasher = await xxhashInit()
    xxhash64Raw = hasher.h64Raw
  })()
  await xxhashPromise
}

/**
 * Extract text from the first user message's first text block.
 * Kept for diagnostics/backward-compatible tests; CCH signing no longer uses it.
 */
export function extractFirstUserMessageText(messages: Message[]): string {
  const userMsg = messages.find((message) => message.role === 'user')
  if (!userMsg) return ''

  const { content } = userMsg
  if (typeof content === 'string') return content

  if (Array.isArray(content)) {
    const textBlock = content.find((block) => block.type === 'text')
    if (textBlock?.text) return textBlock.text
  }

  return ''
}

/**
 * Compute Claude Code's cch token over the final serialized request body.
 *
 * Real Claude Code signs the full body bytes with xxHash64 using a fixed seed,
 * masks to 20 bits, and writes that value into the billing-header placeholder.
 */
export async function computeCCH(bodyBytes: Uint8Array): Promise<string> {
  await ensureXxhash()
  const hash = xxhash64Raw?.(bodyBytes, CCH_SEED) ?? 0n
  return (hash & 0xfffffn).toString(16).padStart(5, '0')
}

export async function signRequestBody(bodyString: string): Promise<string> {
  if (!CCH_PATTERN.test(bodyString)) return bodyString

  const token = await computeCCH(new TextEncoder().encode(bodyString))
  return bodyString.replace(CCH_PATTERN, `cch=${token};`)
}

/**
 * Compute a stable 3-character suffix for cc_version.
 *
 * The previous implementation sampled the first user message, which could make
 * the system billing header change with conversation content. Keep this suffix
 * stable for a day so it resembles a rotating Claude Code fingerprint without
 * busting prompt-cache prefixes on every turn.
 */
export function computeVersionSuffix(
  version: string = CLAUDE_CODE_VERSION,
  date: Date = new Date(),
): string {
  const dayStamp = date.toISOString().slice(0, 10)
  return createHash('sha256')
    .update(`${dayStamp}${version}`)
    .digest('hex')
    .slice(0, 3)
}

/**
 * Build the billing header with a cch placeholder.
 * signRequestBody() must run after final request serialization to replace it.
 */
export function buildBillingHeaderValue(
  _messages: Message[],
  version: string = CLAUDE_CODE_VERSION,
  entrypoint: string,
  date: Date = new Date(),
): string {
  const suffix = computeVersionSuffix(version, date)

  return (
    'x-anthropic-billing-header: ' +
    `cc_version=${version}.${suffix}; ` +
    `cc_entrypoint=${entrypoint}; ` +
    'cch=00000;'
  )
}
