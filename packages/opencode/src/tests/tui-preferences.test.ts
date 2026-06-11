import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeEffectiveOrder,
  DEFAULT_PREFS,
  getTuiPreferencesFile,
  PLUGIN_KEY,
  queueTuiPreferenceUpdate,
  readTuiPreferencesFile,
  resolveAnthropicAuthPrefs,
  TUI_PREFS_FILE_ENV,
} from '../tui-preferences'

let dir: string
let file: string
const savedEnv: Record<string, string | undefined> = {}
const ENV_KEYS = [TUI_PREFS_FILE_ENV, 'OPENCODE_CONFIG_DIR', 'XDG_CONFIG_HOME']

beforeEach(async () => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key]
  dir = await mkdtemp(join(tmpdir(), 'tui-prefs-test-'))
  file = join(dir, 'tui-preferences.jsonc')
  process.env[TUI_PREFS_FILE_ENV] = file
})

afterEach(async () => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
  await rm(dir, { recursive: true, force: true })
})

describe('getTuiPreferencesFile', () => {
  test('env override wins', () => {
    expect(getTuiPreferencesFile()).toBe(file)
  })

  test('OPENCODE_CONFIG_DIR beats XDG_CONFIG_HOME', () => {
    delete process.env[TUI_PREFS_FILE_ENV]
    process.env.OPENCODE_CONFIG_DIR = '/cfg/opencode-dir'
    process.env.XDG_CONFIG_HOME = '/xdg'
    expect(getTuiPreferencesFile()).toBe(
      '/cfg/opencode-dir/tui-preferences.jsonc',
    )
  })

  test('XDG_CONFIG_HOME fallback appends opencode/', () => {
    delete process.env[TUI_PREFS_FILE_ENV]
    delete process.env.OPENCODE_CONFIG_DIR
    process.env.XDG_CONFIG_HOME = '/xdg'
    expect(getTuiPreferencesFile()).toBe('/xdg/opencode/tui-preferences.jsonc')
  })
})

describe('readTuiPreferencesFile', () => {
  test('missing file returns empty object', async () => {
    expect(await readTuiPreferencesFile()).toEqual({})
  })

  test('parses JSONC with comments and trailing commas', async () => {
    await writeFile(
      file,
      `// header comment\n{\n  // plugin\n  "anthropic-auth": { "order": 5, },\n}\n`,
      'utf8',
    )
    const root = await readTuiPreferencesFile()
    expect(root).toEqual({ 'anthropic-auth': { order: 5 } })
  })

  test('malformed file returns empty object', async () => {
    await writeFile(file, '{{{{ not json', 'utf8')
    expect(await readTuiPreferencesFile()).toEqual({})
  })

  test('non-object root returns empty object', async () => {
    await writeFile(file, '[1, 2, 3]', 'utf8')
    expect(await readTuiPreferencesFile()).toEqual({})
  })
})

describe('resolveAnthropicAuthPrefs', () => {
  test('empty root yields defaults', () => {
    const prefs = resolveAnthropicAuthPrefs({})
    expect(prefs).toEqual(DEFAULT_PREFS)
    expect(prefs.order).toBe(160)
    expect(prefs.collapsed).toBeNull()
  })

  test('valid values pass through', () => {
    const prefs = resolveAnthropicAuthPrefs({
      'anthropic-auth': {
        forceToTop: true,
        order: -500,
        startCollapsed: true,
        rememberCollapsed: false,
        collapsed: true,
        pollMs: 5000,
        refreshDebounceMs: 100,
        header: { label: 'QUOTA', showVersion: false },
        sections: { routing: false, cache: false },
        appearance: { barWidth: 20, warnThreshold: 60, errorThreshold: 90 },
      },
    })
    expect(prefs.forceToTop).toBe(true)
    expect(prefs.order).toBe(-500)
    expect(prefs.startCollapsed).toBe(true)
    expect(prefs.rememberCollapsed).toBe(false)
    expect(prefs.collapsed).toBe(true)
    expect(prefs.pollMs).toBe(5000)
    expect(prefs.refreshDebounceMs).toBe(100)
    expect(prefs.header).toEqual({ label: 'QUOTA', showVersion: false })
    expect(prefs.sections).toEqual({
      quota: true,
      fallbackAccounts: true,
      routing: false,
      cache: false,
      health: true,
    })
    expect(prefs.appearance.barWidth).toBe(20)
    expect(prefs.appearance.warnThreshold).toBe(60)
    expect(prefs.appearance.errorThreshold).toBe(90)
  })

  test('numbers are clamped to their ranges', () => {
    const prefs = resolveAnthropicAuthPrefs({
      'anthropic-auth': {
        order: 99999999,
        pollMs: 1,
        refreshDebounceMs: 999999,
        appearance: { barWidth: 1000, warnThreshold: -5, errorThreshold: 400 },
      },
    })
    expect(prefs.order).toBe(10000)
    expect(prefs.pollMs).toBe(500)
    expect(prefs.refreshDebounceMs).toBe(5000)
    expect(prefs.appearance.barWidth).toBe(40)
    expect(prefs.appearance.warnThreshold).toBe(0)
    expect(prefs.appearance.errorThreshold).toBe(100)
  })

  test('errorThreshold is forced above warnThreshold', () => {
    const prefs = resolveAnthropicAuthPrefs({
      'anthropic-auth': {
        appearance: { warnThreshold: 80, errorThreshold: 30 },
      },
    })
    expect(prefs.appearance.warnThreshold).toBe(80)
    expect(prefs.appearance.errorThreshold).toBe(81)
  })

  test('label is truncated to 20 chars and empty label falls back', () => {
    const long = resolveAnthropicAuthPrefs({
      'anthropic-auth': { header: { label: 'X'.repeat(50) } },
    })
    expect(long.header.label).toBe('X'.repeat(20))
    const empty = resolveAnthropicAuthPrefs({
      'anthropic-auth': { header: { label: '' } },
    })
    expect(empty.header.label).toBe('CLAUDE')
  })

  test('bar chars reduce to first code point', () => {
    const prefs = resolveAnthropicAuthPrefs({
      'anthropic-auth': {
        appearance: { barFilledChar: 'abc', barEmptyChar: '🟦🟦' },
      },
    })
    expect(prefs.appearance.barFilledChar).toBe('a')
    expect(prefs.appearance.barEmptyChar).toBe('🟦')
  })

  test('wrong types fall back per key, unknown keys ignored', () => {
    const prefs = resolveAnthropicAuthPrefs({
      'anthropic-auth': {
        forceToTop: 'yes',
        order: 'high',
        pollMs: null,
        header: 'big',
        sections: { quota: 1, bogus: true },
        appearance: { barWidth: '12' },
        somethingElse: { nested: true },
      },
    })
    expect(prefs.forceToTop).toBe(false)
    expect(prefs.order).toBe(160)
    expect(prefs.pollMs).toBe(1500)
    expect(prefs.header).toEqual(DEFAULT_PREFS.header)
    expect(prefs.sections.quota).toBe(true)
    expect(prefs.appearance.barWidth).toBe(10)
    expect('bogus' in prefs.sections).toBe(false)
  })

  test('non-object plugin entry yields defaults', () => {
    expect(resolveAnthropicAuthPrefs({ 'anthropic-auth': 42 })).toEqual(
      DEFAULT_PREFS,
    )
  })
})

describe('computeEffectiveOrder', () => {
  test('missing key returns default order', () => {
    expect(computeEffectiveOrder({}, 'anthropic-auth', 160)).toBe(160)
  })

  test('explicit order knob is used and clamped', () => {
    expect(
      computeEffectiveOrder(
        { 'anthropic-auth': { order: 42 } },
        'anthropic-auth',
        160,
      ),
    ).toBe(42)
    expect(
      computeEffectiveOrder(
        { 'anthropic-auth': { order: -99999999 } },
        'anthropic-auth',
        160,
      ),
    ).toBe(-10000)
  })

  test('forceToTop beats any explicit order', () => {
    expect(
      computeEffectiveOrder(
        { 'anthropic-auth': { forceToTop: true, order: -10000 } },
        'anthropic-auth',
        160,
      ),
    ).toBe(-100000)
  })

  test('multiple forced plugins order by key position in file', () => {
    const root = {
      'plugin-a': { forceToTop: true },
      'plugin-b': { order: 5 },
      'plugin-c': { forceToTop: true },
    }
    expect(computeEffectiveOrder(root, 'plugin-a', 0)).toBe(-100000)
    expect(computeEffectiveOrder(root, 'plugin-c', 0)).toBe(-99998)
    expect(computeEffectiveOrder(root, 'plugin-b', 0)).toBe(5)
  })

  test('non-boolean forceToTop is ignored', () => {
    expect(
      computeEffectiveOrder(
        { 'anthropic-auth': { forceToTop: 'yes' } },
        'anthropic-auth',
        160,
      ),
    ).toBe(160)
  })
})

describe('queueTuiPreferenceUpdate', () => {
  test('creates file with template on first write', async () => {
    await queueTuiPreferenceUpdate(PLUGIN_KEY, ['collapsed'], true)
    const text = await readFile(file, 'utf8')
    expect(text).toContain('Shared preferences for opencode TUI plugins')
    const root = await readTuiPreferencesFile()
    expect(root).toEqual({ 'anthropic-auth': { collapsed: true } })
  })

  test('preserves comments and unrelated keys on update', async () => {
    const original = `// my notes
{
  // keep me
  "other-plugin": { "forceToTop": true },
  "anthropic-auth": {
    "pollMs": 2000, // tuned
    "collapsed": false
  }
}
`
    await writeFile(file, original, 'utf8')
    await queueTuiPreferenceUpdate(PLUGIN_KEY, ['collapsed'], true)
    const text = await readFile(file, 'utf8')
    expect(text).toContain('// my notes')
    expect(text).toContain('// keep me')
    expect(text).toContain('// tuned')
    expect(text).toContain('"pollMs": 2000')
    const root = await readTuiPreferencesFile()
    expect(root['other-plugin']).toEqual({ forceToTop: true })
    expect((root['anthropic-auth'] as Record<string, unknown>).collapsed).toBe(
      true,
    )
  })

  test('writes nested paths', async () => {
    await queueTuiPreferenceUpdate(PLUGIN_KEY, ['header', 'label'], 'Q')
    const root = await readTuiPreferencesFile()
    expect(root).toEqual({ 'anthropic-auth': { header: { label: 'Q' } } })
  })

  test('rapid sequential updates land the final value', async () => {
    const writes = [true, false, true, false].map((value) =>
      queueTuiPreferenceUpdate(PLUGIN_KEY, ['collapsed'], value),
    )
    await Promise.all(writes)
    const root = await readTuiPreferencesFile()
    expect((root['anthropic-auth'] as Record<string, unknown>).collapsed).toBe(
      false,
    )
  })

  test('no temp files are left behind', async () => {
    await queueTuiPreferenceUpdate(PLUGIN_KEY, ['collapsed'], true)
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(dir)
    expect(entries).toEqual(['tui-preferences.jsonc'])
  })
})
