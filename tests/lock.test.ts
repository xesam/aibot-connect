import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { acquireLock, releaseLock, LockHeldError } from '../src/lock.js'

describe('lock', () => {
  let tmpDir: string
  let lockPath: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `aibot-lock-test-${randomUUID()}`)
    await mkdir(tmpDir, { recursive: true })
    lockPath = join(tmpDir, 'bridge.lock')
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('acquireLock creates a lock file containing this pid', async () => {
    await acquireLock(lockPath)
    const content = await readFile(lockPath, 'utf-8')
    expect(parseInt(content, 10)).toBe(process.pid)
  })

  it('releaseLock removes the lock file', async () => {
    await acquireLock(lockPath)
    await releaseLock(lockPath)
    expect(existsSync(lockPath)).toBe(false)
  })

  it('throws LockHeldError when an active process holds the lock', async () => {
    await writeFile(lockPath, String(process.pid), 'utf-8')
    await expect(acquireLock(lockPath)).rejects.toBeInstanceOf(LockHeldError)
  })

  it('clears stale lock (pid not running) and re-acquires', async () => {
    // INT_MAX, well above any plausible pid_max
    await writeFile(lockPath, '2147483647', 'utf-8')
    await acquireLock(lockPath)
    const content = await readFile(lockPath, 'utf-8')
    expect(parseInt(content, 10)).toBe(process.pid)
  })

  it('concurrent acquireLock — only one wins', async () => {
    const results = await Promise.allSettled([
      acquireLock(lockPath),
      acquireLock(lockPath),
      acquireLock(lockPath),
    ])
    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(fulfilled.length).toBe(1)
    expect(rejected.length).toBe(2)
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(LockHeldError)
    }
    const content = await readFile(lockPath, 'utf-8')
    expect(parseInt(content, 10)).toBe(process.pid)
  })

  it('LockHeldError carries pid and message', async () => {
    await writeFile(lockPath, String(process.pid), 'utf-8')
    try {
      await acquireLock(lockPath)
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(LockHeldError)
      expect((error as LockHeldError).pid).toBe(process.pid)
      expect((error as LockHeldError).message).toContain(lockPath)
    }
  })
})
