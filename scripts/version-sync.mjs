#!/usr/bin/env node

/**
 * Synchronize publishable package versions from an explicit version or git tag.
 *
 * Usage:
 *   node scripts/version-sync.mjs 1.8.0
 *   node scripts/version-sync.mjs --from-tag
 *   node scripts/version-sync.mjs 1.8.0 --dry-run
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[\w.]+)?(?:\+[\w.]+)?$/
const packageJsonPaths = [
  join(root, 'packages', 'core', 'package.json'),
  join(root, 'packages', 'opencode', 'package.json'),
  join(root, 'packages', 'pi', 'package.json'),
]

function parseArgs(argv) {
  const args = argv.slice(2)
  let version = null
  let fromTag = false
  let dryRun = false

  for (const arg of args) {
    if (arg === '--from-tag') {
      fromTag = true
    } else if (arg === '--dry-run') {
      dryRun = true
    } else if (!version && !arg.startsWith('-')) {
      version = arg
    } else {
      console.error(`Unknown argument: ${arg}`)
      process.exit(1)
    }
  }

  if (fromTag) {
    const ref = process.env.GITHUB_REF_NAME
    if (!ref) {
      console.error('--from-tag requires GITHUB_REF_NAME environment variable')
      process.exit(1)
    }
    version = ref.replace(/^v/, '')
  }

  if (!version) {
    console.error(
      'Usage: version-sync.mjs <version> [--dry-run]\n' +
        '       version-sync.mjs --from-tag [--dry-run]',
    )
    process.exit(1)
  }

  if (!SEMVER_RE.test(version)) {
    console.error(`Invalid semver version: '${version}'`)
    process.exit(1)
  }

  return { version, dryRun }
}

const { version, dryRun } = parseArgs(process.argv)

console.log(
  `${dryRun ? '[DRY RUN] ' : ''}Syncing publishable package versions to ${version}\n`,
)

for (const pkgPath of packageJsonPaths) {
  if (!existsSync(pkgPath)) {
    console.error(`Package file not found: ${pkgPath}`)
    process.exit(1)
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'))
  const relativePath = pkgPath.slice(root.length + 1)

  let changed = false

  if (pkg.version === version) {
    console.log(`${relativePath}: version already at target`)
  } else {
    console.log(`${relativePath}: version ${pkg.version} → ${version}`)
    pkg.version = version
    changed = true
  }

  if (
    pkg.name === '@cortexkit/opencode-anthropic-auth' ||
    pkg.name === '@cortexkit/pi-anthropic-auth'
  ) {
    const currentCoreVersion =
      pkg.dependencies?.['@cortexkit/anthropic-auth-core']
    if (currentCoreVersion !== version) {
      console.log(
        `${relativePath}: @cortexkit/anthropic-auth-core ${currentCoreVersion ?? '(missing)'} → ${version}`,
      )
      pkg.dependencies = {
        ...pkg.dependencies,
        '@cortexkit/anthropic-auth-core': version,
      }
      changed = true
    }
  }

  if (!changed) {
    console.log(`${relativePath}: (already synced)`)
    continue
  }

  if (!dryRun) {
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf-8')
  }
}

console.log(`\n${dryRun ? '[DRY RUN] ' : ''}Done.`)
