import {
  type PrimeManager,
  primeStorageFingerprint,
} from '@cortexkit/anthropic-auth-core'

// One owner per process and resolved storage identity prevents duplicate timers
// without coupling independent account files loaded by separate projects.
const primeManagers = new Map<string, PrimeManager>()

export function adoptPrimeManager(
  storagePath: string,
  create: () => PrimeManager,
): PrimeManager {
  const fingerprint = primeStorageFingerprint(storagePath)
  const existing = primeManagers.get(fingerprint)
  if (existing) return existing

  const manager = create()
  primeManagers.set(fingerprint, manager)
  return manager
}
