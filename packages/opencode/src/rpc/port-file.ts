import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface PortFileEntry {
  port: number
  token: string
  pid: number
  startedAt: number
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function writePortFile(
  dir: string,
  entry: { port: number; token: string; pid: number },
): Promise<string> {
  await mkdir(dir, { recursive: true })
  const full: PortFileEntry = { ...entry, startedAt: Date.now() }
  const target = join(dir, `port-${entry.pid}.json`)
  const tmp = `${target}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(full), { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, target)
  return target
}

export async function discoverPortFile(
  dir: string,
): Promise<PortFileEntry | null> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return null
  }
  const live: PortFileEntry[] = []
  for (const name of names) {
    if (!name.startsWith('port-') || !name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(
        await readFile(join(dir, name), 'utf8'),
      ) as PortFileEntry
      if (Number.isFinite(parsed.port) && pidAlive(parsed.pid))
        live.push(parsed)
    } catch {}
  }
  if (live.length === 0) return null
  return live.sort((a, b) => b.startedAt - a.startedAt)[0] ?? null
}
