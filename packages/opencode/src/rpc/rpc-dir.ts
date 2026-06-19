import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const RPC_DIR_ENV = 'OPENCODE_ANTHROPIC_AUTH_RPC_DIR'

// Both processes must resolve the SAME dir from the SAME project directory.
export function getRpcDir(projectDirectory: string): string {
  const override = process.env[RPC_DIR_ENV]?.trim()
  if (override) return resolve(override)
  const hash = createHash('sha256')
    .update(projectDirectory)
    .digest('hex')
    .slice(0, 16)
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  return join(base, 'cortexkit', 'anthropic-auth', 'rpc', hash)
}

export { tmpdir }
