import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'jsonc-parser'

export const TUI_PREFS_FILE_ENV = 'OPENCODE_TUI_PREFERENCES_FILE'
const FILE_NAME = 'tui-preferences.jsonc'

// Shared preferences file for opencode TUI plugins. One top-level key per
// plugin (short name, e.g. "anthropic-auth"). The file is optional: every
// reader must fall back to defaults when it is missing or malformed.
export function getTuiPreferencesFile(): string {
  const override = process.env[TUI_PREFS_FILE_ENV]
  if (override) return override
  const configDir =
    process.env.OPENCODE_CONFIG_DIR ||
    join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
  return join(configDir, FILE_NAME)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Tolerant read: missing file, parse errors, or a non-object root all resolve
// to {} so the sidebar never crashes on user-edited content. jsonc-parser's
// fault-tolerant parse handles comments and trailing commas.
export async function readTuiPreferencesFile(): Promise<
  Record<string, unknown>
> {
  try {
    const raw = await readFile(getTuiPreferencesFile(), 'utf8')
    const root: unknown = parse(raw)
    return isRecord(root) ? root : {}
  } catch {
    return {}
  }
}
