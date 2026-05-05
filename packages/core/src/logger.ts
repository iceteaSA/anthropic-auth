import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const LOG_FILE = path.join(os.tmpdir(), 'opencode-anthropic-auth.log')
const isTestEnv = process.env.NODE_ENV === 'test'
const FLUSH_INTERVAL_MS = 500
const BUFFER_SIZE_LIMIT = 50

let buffer: string[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

function flush(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  if (buffer.length === 0) return
  const data = buffer.join('')
  buffer = []
  try {
    fs.appendFileSync(LOG_FILE, data)
  } catch {
    // Logging must never throw.
  }
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flush()
  }, FLUSH_INTERVAL_MS)
}

function serialize(data: unknown): string {
  if (data === undefined) return ''
  if (data instanceof Error) {
    return ` ${data.message}${data.stack ? `\n${data.stack}` : ''}`
  }
  return ` ${JSON.stringify(data)}`
}

export function log(message: string, data?: unknown): void {
  if (isTestEnv) return
  try {
    buffer.push(`[${new Date().toISOString()}] ${message}${serialize(data)}\n`)
    if (buffer.length >= BUFFER_SIZE_LIMIT) {
      flush()
    } else {
      scheduleFlush()
    }
  } catch {
    // Logging must never throw.
  }
}

export function relayLog(message: string, data?: unknown): void {
  log(`[relay] ${message}`, data)
}

export function getLogFilePath(): string {
  return LOG_FILE
}

if (!isTestEnv) {
  process.on('exit', flush)
}
