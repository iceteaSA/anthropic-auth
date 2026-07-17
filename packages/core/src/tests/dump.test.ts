import { afterEach, describe, expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sweepDumpDirectory } from '../dump'

const dumpDirs: string[] = []

afterEach(async () => {
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
  test('refuses directories outside the expected tmp prefix', async () => {
    const dumpDir = await mkdtemp(join(tmpdir(), 'unrelated-dumps-test-'))
    dumpDirs.push(dumpDir)
    await writeFile(join(dumpDir, 'old.json'), '12345678')

    expect(await sweepDumpDirectory({ dumpDir, maxBytes: 1 })).toEqual({
      removed: 0,
      freedBytes: 0,
    })
    expect(await readdir(dumpDir)).toEqual(['old.json'])
  })
})
