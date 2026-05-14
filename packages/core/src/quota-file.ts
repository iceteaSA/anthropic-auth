/**
 * Persists main-account quota snapshots to a standalone file so TUI
 * plugins (or any external reader) can display quota without auth.
 *
 * File: ~/.config/opencode/anthropic-auth-quota.json
 * Override: OPENCODE_ANTHROPIC_AUTH_QUOTA_FILE
 *
 * Writes are atomic (write-to-temp + rename) and safe for concurrent
 * sessions — each write replaces the entire file contents.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { OAuthQuotaSnapshot } from './accounts.ts'

export type QuotaFileData = {
  /** Unix ms timestamp of the last successful quota fetch */
  updatedAt: number
  /** Total requests since this opencode session started */
  requestCount: number
  /** Main account quota snapshot */
  main: OAuthQuotaSnapshot | null
  /** Fallback account summaries (id + quota only, no secrets) */
  fallbacks?: Array<{
    id: string
    label?: string
    enabled?: boolean
    quota?: OAuthQuotaSnapshot
  }>
}

const DEFAULT_DIR = join(homedir(), '.config', 'opencode')
const DEFAULT_FILENAME = 'anthropic-auth-quota.json'

function getQuotaFilePath(): string {
  if (process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FILE)
    return process.env.OPENCODE_ANTHROPIC_AUTH_QUOTA_FILE
  return join(DEFAULT_DIR, DEFAULT_FILENAME)
}

/**
 * Atomically write quota data to disk.
 * Safe for concurrent sessions — last writer wins, no corruption.
 */
export async function writeQuotaFile(data: QuotaFileData): Promise<void> {
  const path = getQuotaFilePath()
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  await rename(tempPath, path)
}

/**
 * Read the current quota file. Returns null if it doesn't exist
 * or is unparseable.
 */
export async function readQuotaFile(): Promise<QuotaFileData | null> {
  try {
    const raw = await readFile(getQuotaFilePath(), 'utf8')
    return JSON.parse(raw) as QuotaFileData
  } catch {
    return null
  }
}
