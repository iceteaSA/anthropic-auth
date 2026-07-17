import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sweepDumpDirectory } from '../dump'

const dumpDirs: string[] = []
const dumpLinks: string[] = []
const originalDumpMaxBytes = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_MAX_BYTES
const originalDumpDir = process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR

afterEach(async () => {
  if (originalDumpMaxBytes === undefined) {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_MAX_BYTES
  } else {
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_MAX_BYTES = originalDumpMaxBytes
  }
  if (originalDumpDir === undefined) {
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR
  } else {
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = originalDumpDir
  }
  await Promise.all(
    dumpLinks.splice(0).map((path) => unlink(path).catch(() => {})),
  )
  await Promise.all(
    dumpDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  )
})

test('dump sweep deletes oldest files until the directory is under its cap', async () => {
  const dumpDir = await mkdtemp(
    join(tmpdir(), 'opencode-anthropic-auth-dumps-test-'),
  )
  dumpDirs.push(dumpDir)
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
  const oldFile = join(dumpDir, 'old.json')
  const middleFile = join(dumpDir, 'middle.json')
  const newestFile = join(dumpDir, 'newest.json')
  await mkdir(dumpDir, { recursive: true })
  await Promise.all([
    writeFile(oldFile, '12345678'),
    writeFile(middleFile, '12345678'),
    writeFile(newestFile, '12345678'),
  ])
  await utimes(oldFile, new Date(1_000), new Date(1_000))
  await utimes(middleFile, new Date(2_000), new Date(2_000))
  await utimes(newestFile, new Date(3_000), new Date(3_000))

  const result = await sweepDumpDirectory({
    dumpDir,
    maxBytes: 12,
    protectedPaths: [newestFile],
  })

  expect(result).toEqual({ removed: 2, freedBytes: 16 })
  expect(await readdir(dumpDir)).toEqual(['newest.json'])
})

describe('dump sweep safety guard', () => {
  test('refuses a configured symlinked dump directory without deleting target files', async () => {
    const targetDir = await mkdtemp(join(tmpdir(), 'target-dir-secret-'))
    dumpDirs.push(targetDir)
    const secretFile = join(targetDir, 'secret.txt')
    await writeFile(secretFile, 'do not delete me')
    const dumpDir = join(
      tmpdir(),
      `opencode-anthropic-auth-dumps-link-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    )
    dumpLinks.push(dumpDir)
    await symlink(targetDir, dumpDir)
    process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir

    expect(await sweepDumpDirectory({ maxBytes: 0 })).toEqual({
      removed: 0,
      freedBytes: 0,
    })
    expect(await readdir(targetDir)).toEqual(['secret.txt'])
  })

  test('refuses a directory that is not configured for dumps', async () => {
    const dumpDir = await mkdtemp(join(tmpdir(), 'unrelated-dumps-test-'))
    dumpDirs.push(dumpDir)
    await writeFile(join(dumpDir, 'old.json'), '12345678')
    delete process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR

    expect(await sweepDumpDirectory({ dumpDir, maxBytes: 1 })).toEqual({
      removed: 0,
      freedBytes: 0,
    })
    expect(await readdir(dumpDir)).toEqual(['old.json'])
  })
})

test('enforces the cap in a configured custom dump directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'custom-dump-root-'))
  dumpDirs.push(root)
  const dumpDir = join(root, 'dumps')
  await mkdir(dumpDir)
  const oldFile = join(dumpDir, 'old.json')
  await writeFile(oldFile, '12345678')
  await utimes(oldFile, new Date(1_000), new Date(1_000))
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir

  expect(await sweepDumpDirectory({ maxBytes: 0 })).toEqual({
    removed: 1,
    freedBytes: 8,
  })
  expect(await readdir(dumpDir)).toEqual([])
})

test('honors an explicit zero-byte cap from the environment', async () => {
  const dumpDir = await mkdtemp(
    join(tmpdir(), 'opencode-anthropic-auth-dumps-test-'),
  )
  dumpDirs.push(dumpDir)
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
  const oldFile = join(dumpDir, 'old.json')
  await writeFile(oldFile, '12345678')
  await utimes(oldFile, new Date(1_000), new Date(1_000))
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_MAX_BYTES = '0'

  expect(await sweepDumpDirectory({ dumpDir })).toEqual({
    removed: 1,
    freedBytes: 8,
  })
  expect(await readdir(dumpDir)).toEqual([])
})

test('preserves files younger than the sweep newness floor', async () => {
  const dumpDir = await mkdtemp(
    join(tmpdir(), 'opencode-anthropic-auth-dumps-test-'),
  )
  dumpDirs.push(dumpDir)
  process.env.OPENCODE_ANTHROPIC_AUTH_DUMP_DIR = dumpDir
  const recentFile = join(dumpDir, 'recent.json')
  const now = new Date('2026-07-17T12:00:00.000Z')
  await writeFile(recentFile, '12345678')
  await utimes(recentFile, now, now)

  expect(
    await sweepDumpDirectory({
      dumpDir,
      maxBytes: 0,
      now: now.getTime(),
    }),
  ).toEqual({ removed: 0, freedBytes: 0 })
  expect(await readdir(dumpDir)).toEqual(['recent.json'])
})
