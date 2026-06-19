import { afterEach, describe, expect, test } from 'bun:test'
import { isAbsolute } from 'node:path'
import { getRpcDir } from '../rpc/rpc-dir'

const RPC_DIR_ENV = 'OPENCODE_ANTHROPIC_AUTH_RPC_DIR'

describe('getRpcDir', () => {
  const prev = process.env[RPC_DIR_ENV]

  afterEach(() => {
    if (prev === undefined) {
      delete process.env[RPC_DIR_ENV]
    } else {
      process.env[RPC_DIR_ENV] = prev
    }
  })

  test('returns hash-based path without override', () => {
    delete process.env[RPC_DIR_ENV]
    const dir = getRpcDir('/home/user/project')
    expect(dir).toInclude('cortexkit/anthropic-auth/rpc/')
    expect(isAbsolute(dir)).toBe(true)
  })

  test('resolves relative override anchored to projectDirectory (not cwd)', () => {
    process.env[RPC_DIR_ENV] = 'relative/path/to/rpc'
    const dir = getRpcDir('/home/user/project')
    expect(isAbsolute(dir)).toBe(true)
    // Must be anchored to projectDirectory, not just cwd
    expect(dir).toBe('/home/user/project/relative/path/to/rpc')
  })

  test('returns absolute override unchanged (still absolute)', () => {
    process.env[RPC_DIR_ENV] = '/absolute/path/to/rpc'
    const dir = getRpcDir('/home/user/project')
    expect(dir).toBe('/absolute/path/to/rpc')
    expect(isAbsolute(dir)).toBe(true)
  })

  test('returns tmpdir-based path when override is empty string', () => {
    process.env[RPC_DIR_ENV] = ''
    const dir = getRpcDir('/home/user/project')
    expect(dir).toInclude('cortexkit/anthropic-auth/rpc/')
    expect(isAbsolute(dir)).toBe(true)
  })
})
