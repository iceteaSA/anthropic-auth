/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from 'bun:test'
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  utimes,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  removeE2ETempDir,
  sweepStaleE2ETempDirs,
} from '../src/opencode-runner.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createRoot() {
  const root = await mkdtemp(join(tmpdir(), 'anthropic-auth-e2e-hygiene-test-'))
  roots.push(root)
  return root
}

describe('e2e temporary directory hygiene', () => {
  it('removes only stale sibling run directories without following symlinks', async () => {
    const root = await createRoot()
    const oldDir = join(root, 'anthropic-auth-e2e-old')
    const newDir = join(root, 'anthropic-auth-e2e-new')
    const symlinkTarget = join(root, 'symlink-target')
    const staleTime = new Date('2026-07-15T00:00:00.000Z')
    const now = new Date('2026-07-17T00:00:00.000Z')

    await Promise.all([
      mkdir(oldDir),
      mkdir(newDir),
      mkdir(symlinkTarget),
    ])
    await symlink(symlinkTarget, join(root, 'anthropic-auth-e2e-link'))
    await utimes(oldDir, staleTime, staleTime)
    await utimes(newDir, now, now)

    await sweepStaleE2ETempDirs({ root, now: now.getTime() })

    expect((await readdir(root)).sort()).toEqual([
      'anthropic-auth-e2e-link',
      'anthropic-auth-e2e-new',
      'symlink-target',
    ])
    expect((await lstat(symlinkTarget)).isDirectory()).toBe(true)
  })

  it('removes a verified run directory unless the keep escape hatch is enabled', async () => {
    const root = await createRoot()
    const removedDir = join(root, 'anthropic-auth-e2e-remove')
    const keptDir = join(root, 'anthropic-auth-e2e-keep')
    await Promise.all([mkdir(removedDir), mkdir(keptDir)])

    expect(await removeE2ETempDir(removedDir, { root })).toBe(true)
    expect(
      await removeE2ETempDir(keptDir, { root, keep: true }),
    ).toBe(false)
    expect((await readdir(root)).sort()).toEqual(['anthropic-auth-e2e-keep'])
  })

  it('refuses to remove paths outside the expected prefix', async () => {
    const root = await createRoot()
    const unrelated = join(root, 'unrelated')
    await mkdir(unrelated)

    expect(await removeE2ETempDir(unrelated, { root })).toBe(false)
    expect((await lstat(unrelated)).isDirectory()).toBe(true)
  })
})
