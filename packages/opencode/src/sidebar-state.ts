export interface QuotaWindow {
  usedPercent: number
  remainingPercent: number
  resetsAt?: string
}

export interface AccountQuota {
  five_hour?: QuotaWindow
  seven_day?: QuotaWindow
}

export interface SidebarAccountState {
  id: string
  label: string | undefined
  quota: AccountQuota | null
  enabled: boolean
}

export interface SidebarState {
  main: {
    quota: AccountQuota | null
    quotaBackedOff?: boolean
    quotaBackoffUntil?: number
    refreshBackedOff?: boolean
    refreshBackoffUntil?: number
  }
  fallbacks: SidebarAccountState[]
  activeId: string | undefined
  route: string
  relay: { enabled: boolean; transport: string } | null
  fastMode: boolean
  cacheKeep?: {
    enabled: boolean
    window?: string
    trackedSessions?: number
  }
  lastUpdated: number
}

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const STATE_FILE_ENV = 'OPENCODE_ANTHROPIC_AUTH_SIDEBAR_STATE_FILE'
const DEFAULT_STATE_DIR = join(tmpdir(), 'opencode-anthropic-auth')
const DEFAULT_STATE_FILE = join(DEFAULT_STATE_DIR, 'sidebar-state.json')

export function getSidebarStateFile(): string {
  return process.env[STATE_FILE_ENV] || DEFAULT_STATE_FILE
}

export const DEFAULT_SIDEBAR_STATE: SidebarState = {
  main: { quota: null },
  fallbacks: [],
  activeId: undefined,
  route: 'main',
  relay: null,
  fastMode: false,
  lastUpdated: 0,
}

export async function getSidebarState(): Promise<SidebarState> {
  try {
    const raw = await readFile(getSidebarStateFile(), 'utf8')
    return JSON.parse(raw) as SidebarState
  } catch {
    return DEFAULT_SIDEBAR_STATE
  }
}

export async function setSidebarState(state: SidebarState): Promise<void> {
  try {
    const stateFile = getSidebarStateFile()
    await mkdir(dirname(stateFile), { recursive: true })
    await writeFile(stateFile, JSON.stringify(state), 'utf8')
  } catch {
    // Best-effort — sidebar is non-critical
  }
}
