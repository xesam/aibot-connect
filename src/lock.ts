import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { execSync } from 'node:child_process'

const DEFAULT_LOCK_FILE = join(process.cwd(), 'data', 'bridge.lock')

export class LockHeldError extends Error {
  readonly pid: number
  constructor(pid: number, lockFile: string) {
    super(`Already running (PID ${pid}). Stop it first or delete ${lockFile}`)
    this.name = 'LockHeldError'
    this.pid = pid
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      const result = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV`, {
        encoding: 'utf-8',
        windowsHide: true,
        timeout: 3000,
      })
      return result.split('\n').slice(1).some((line) => {
        const cols = line.split(',')
        return cols[1] === `"${pid}"`
      })
    }
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function acquireLock(lockFilePath: string = DEFAULT_LOCK_FILE): Promise<void> {
  await mkdir(dirname(lockFilePath), { recursive: true })

  try {
    await writeFile(lockFilePath, String(process.pid), { encoding: 'utf-8', flag: 'wx' })
    return
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code !== 'EEXIST') throw error
  }

  const content = await readFile(lockFilePath, 'utf-8').catch(() => '')
  const pid = parseInt(content.trim(), 10)
  if (!isNaN(pid) && isProcessRunning(pid)) {
    throw new LockHeldError(pid, lockFilePath)
  }

  // stale: remove and retry once with wx
  await unlink(lockFilePath).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e
  })
  try {
    await writeFile(lockFilePath, String(process.pid), { encoding: 'utf-8', flag: 'wx' })
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err.code === 'EEXIST') {
      const newContent = await readFile(lockFilePath, 'utf-8').catch(() => '')
      const newPid = parseInt(newContent.trim(), 10)
      throw new LockHeldError(isNaN(newPid) ? -1 : newPid, lockFilePath)
    }
    throw error
  }
}

export async function releaseLock(lockFilePath: string = DEFAULT_LOCK_FILE): Promise<void> {
  await unlink(lockFilePath).catch(() => {})
}
