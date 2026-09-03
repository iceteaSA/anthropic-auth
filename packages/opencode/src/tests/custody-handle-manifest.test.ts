import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test'
import { constants as fsConstants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  CustodyHandleManifestReader,
  readCustodyHandles,
} from '@cortexkit/anthropic-auth-core'
import { loadGoldenCustodyManifest } from './custody-handle-manifest.fixture.ts'

const { text: fixtureText, manifest: fixture } =
  await loadGoldenCustodyManifest()

async function withTempDirectory<T>(
  callback: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'custody-manifest-test-'))
  try {
    return await callback(directory)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
}

async function withManifest<T>(
  content: string,
  callback: (path: string) => Promise<T>,
): Promise<T> {
  return withTempDirectory(async (directory) => {
    const parent = join(directory, 'manifest')
    const path = join(parent, 'handles.json')
    await fs.mkdir(parent)
    await fs.chmod(parent, 0o700)
    await fs.writeFile(path, content)
    await fs.chmod(path, 0o600)
    await fs.lstat(path)
    return callback(path)
  })
}

function reader(path: string, expectedUid?: number) {
  return new CustodyHandleManifestReader({
    path,
    provider: 'anthropic',
    serve: 'anthropic-auth',
    expectedUid,
  })
}

async function expectInvalid(
  result: Promise<Awaited<ReturnType<CustodyHandleManifestReader['read']>>>,
  reason: string,
): Promise<void> {
  const value = await result
  expect(value.status).toBe('invalid')
  if (value.status !== 'invalid') throw new Error('expected invalid manifest')
  expect(value.reason).toBe(reason)
}

async function expectIgnored(
  result: Promise<Awaited<ReturnType<CustodyHandleManifestReader['read']>>>,
  reason: 'foreign-serve' | 'missing-provider',
): Promise<void> {
  const value = await result
  expect(value.status).toBe('ignored')
  if (value.status !== 'ignored') throw new Error('expected ignored manifest')
  expect(value.reason).toBe(reason)
}

function withProvider(
  mutate: (provider: Record<string, unknown>) => void,
): string {
  const value = structuredClone(fixture) as {
    version: number
    providers: Array<Record<string, unknown>>
  }
  const provider = value.providers.find(
    (entry) => entry.provider === 'anthropic',
  )
  if (!provider) throw new Error('missing anthropic fixture')
  mutate(provider)
  return JSON.stringify(value)
}

afterEach(() => {
  mock.restore()
})

describe('CustodyHandleManifestReader', () => {
  test('reads the version 1 anthropic-auth manifest and ignores other providers', async () => {
    await withManifest(fixtureText, async (path) => {
      const result = await reader(path).read()
      expect(result.status).toBe('ready')
      if (result.status !== 'ready') throw new Error('expected ready manifest')
      expect(result.manifest).toMatchObject({
        version: 1,
        provider: 'anthropic',
        serve: 'anthropic-auth',
      })
      expect(result.manifest.accounts).toHaveLength(1)
    })
  })

  test('ignores an anthropic block with a foreign serve', async () => {
    await withManifest(
      withProvider((provider) => {
        provider.serve = 'foreign-serve'
      }),
      async (path) => {
        await expectIgnored(reader(path).read(), 'foreign-serve')
      },
    )
  })

  test('ignores a manifest without an anthropic block', async () => {
    const value = structuredClone(fixture) as typeof fixture
    value.providers = value.providers.filter(
      (provider) => provider.provider !== 'anthropic',
    )
    await withManifest(JSON.stringify(value), async (path) => {
      await expectIgnored(reader(path).read(), 'missing-provider')
    })
  })

  test('rejects reserved account labels without inheriting prototype keys', () => {
    const source = Object.assign(
      Object.create({ providers: fixture.providers }),
      { version: 1 },
    ) as Record<string, unknown>
    expect(() =>
      readCustodyHandles(source, 'anthropic', 'anthropic-auth'),
    ).toThrow('missing manifest providers')

    for (const label of ['__proto__', 'constructor', 'prototype']) {
      expect(() =>
        readCustodyHandles(
          JSON.parse(
            withProvider((provider) => {
              provider.accounts = [
                { ...fixture.providers[1]?.accounts[0], label },
              ]
            }),
          ),
          'anthropic',
          'anthropic-auth',
        ),
      ).toThrow('invalid account label')
    }
  })

  test('rejects invalid labels with a fixed reason', async () => {
    await withManifest(
      withProvider((provider) => {
        provider.accounts = [
          { ...fixture.providers[1]?.accounts[0], label: 'Bad' },
        ]
      }),
      async (path) => {
        await expect(reader(path).read()).resolves.toEqual({
          status: 'invalid',
          reason: 'invalid account label',
        })
      },
    )
  })

  test('rejects invalid handles with a fixed reason', async () => {
    await withManifest(
      withProvider((provider) => {
        provider.accounts = [
          { ...fixture.providers[1]?.accounts[0], handle: 'invalid' },
        ]
      }),
      async (path) => {
        await expect(reader(path).read()).resolves.toEqual({
          status: 'invalid',
          reason: 'invalid account handle',
        })
      },
    )
  })

  test('collects validated superseded handles into a set', async () => {
    const legacyHandle = fixture.providers[0]?.accounts[1]?.superseded?.[0]
    if (typeof legacyHandle !== 'string')
      throw new Error('missing fixture handle')
    await withManifest(
      withProvider((provider) => {
        provider.accounts = [
          { ...fixture.providers[1]?.accounts[0], superseded: [legacyHandle] },
        ]
      }),
      async (path) => {
        const result = await reader(path).read()
        expect(result.status).toBe('ready')
        if (result.status !== 'ready')
          throw new Error('expected ready manifest')
        expect(result.manifest.superseded.size).toBe(1)
        expect(result.manifest.superseded.has(legacyHandle)).toBe(true)
      },
    )
  })

  test('rejects a symlink', async () => {
    await withTempDirectory(async (directory) => {
      const target = join(directory, 'target.json')
      const path = join(directory, 'handles.json')
      await fs.writeFile(target, fixtureText)
      await fs.chmod(target, 0o600)
      await fs.symlink(target, path)
      await expectInvalid(reader(path).read(), 'manifest is a symlink')
    })
  })

  test('rejects a non-regular manifest path', async () => {
    await withTempDirectory(async (directory) => {
      const path = join(directory, 'handles.json')
      await fs.mkdir(path)
      await expectInvalid(reader(path).read(), 'manifest is not a regular file')
    })
  })

  test('rejects a manifest with a mode other than 0600', async () => {
    await withManifest(fixtureText, async (path) => {
      await fs.chmod(path, 0o644)
      await expectInvalid(reader(path).read(), 'manifest mode must be 0600')
    })
  })

  test('rejects a manifest with restrictive but non-0600 mode', async () => {
    await withManifest(fixtureText, async (path) => {
      await fs.chmod(path, 0o400)
      await fs.lstat(path)
      await expectInvalid(reader(path).read(), 'manifest mode must be 0600')
    })
  })

  test('opens a validated manifest with O_NOFOLLOW', async () => {
    await withManifest(fixtureText, async (path) => {
      const openSpy = spyOn(fs, 'open')

      await expect(reader(path).read()).resolves.toMatchObject({
        status: 'ready',
      })

      const [, flags] = openSpy.mock.calls[0] ?? []
      expect((Number(flags) & fsConstants.O_NOFOLLOW) !== 0).toBe(true)
    })
  })

  test('rejects a manifest owned by a different uid', async () => {
    await withManifest(fixtureText, async (path) => {
      await expectInvalid(
        reader(path, (process.getuid?.() ?? 0) + 1).read(),
        'manifest owner does not match',
      )
    })
  })

  test('rejects a parent directory owned by a different uid', async () => {
    await withManifest(fixtureText, async (path) => {
      const parent = dirname(path)
      const originalLstat = fs.lstat
      spyOn(fs, 'lstat').mockImplementation(async (target) => {
        const stats = await originalLstat(target)
        if (target !== parent) return stats
        return Object.assign(Object.create(stats), {
          uid: (process.getuid?.() ?? 0) + 1,
        })
      })
      await expectInvalid(
        reader(path).read(),
        'manifest parent owner does not match',
      )
    })
  })

  test('rejects a world-writable parent directory without sticky mode', async () => {
    await withManifest(fixtureText, async (path) => {
      await fs.chmod(dirname(path), 0o777)
      await expectInvalid(
        reader(path).read(),
        'manifest parent is world-writable',
      )
    })
  })

  test('rejects a manifest larger than 256 KiB', async () => {
    await withManifest('x'.repeat(256 * 1024 + 1), async (path) => {
      await expectInvalid(reader(path).read(), 'manifest exceeds maximum size')
    })
  })

  test('returns absent for a missing manifest', async () => {
    await withTempDirectory(async (directory) => {
      await expect(
        reader(join(directory, 'missing.json')).read(),
      ).resolves.toEqual({
        status: 'absent',
      })
    })
  })

  test('redacts malformed JSON source bytes', async () => {
    const bareToken = `ckh_${'A'.repeat(43)}`
    await withManifest(`{"version":1, ${bareToken}}`, async (path) => {
      const result = await reader(path).read()
      expect(result.status).toBe('invalid')
      if (result.status !== 'invalid')
        throw new Error('expected invalid manifest')
      expect(result.reason === 'invalid JSON').toBe(true)
      expect(result.reason.includes(bareToken)).toBe(false)
    })
  })

  test('caches parsed content by metadata while rechecking file mode', async () => {
    await withManifest(fixtureText, async (path) => {
      const openSpy = spyOn(fs, 'open')
      const manifestReader = reader(path)
      await expect(manifestReader.read()).resolves.toMatchObject({
        status: 'ready',
      })
      await expect(manifestReader.read()).resolves.toMatchObject({
        status: 'ready',
      })
      expect(openSpy).toHaveBeenCalledTimes(1)

      await fs.chmod(path, 0o644)
      await expectInvalid(manifestReader.read(), 'manifest mode must be 0600')
      expect(openSpy).toHaveBeenCalledTimes(1)
    })
  })
})
