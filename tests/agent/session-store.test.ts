import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdir, rm, readFile, writeFile, stat, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import {
  MemorySessionStore,
  FileSessionStore,
  type SessionEntry,
} from '../../src/agent/session-store.js'

function makeEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    chatId: 'chat-001',
    agentName: 'claude-code-cli',
    agentSessionId: 'sess-abc123',
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCostUsd: 0.05,
    lastActiveTime: Date.now(),
    createdAt: Date.now(),
    ...overrides,
  }
}

// ===== MemorySessionStore =====

describe('MemorySessionStore', () => {
  let store: MemorySessionStore

  beforeEach(() => { store = new MemorySessionStore() })

  it('returns undefined for unknown key', () => {
    expect(store.get('nonexistent')).toBeUndefined()
  })

  it('stores and retrieves an entry', () => {
    const entry = makeEntry()
    store.set(entry.chatId, entry)
    expect(store.get(entry.chatId)).toEqual(entry)
  })

  it('deletes an entry', () => {
    const entry = makeEntry()
    store.set(entry.chatId, entry)
    store.delete(entry.chatId)
    expect(store.get(entry.chatId)).toBeUndefined()
  })

  it('overwrites an existing entry', () => {
    const entry1 = makeEntry({ chatId: 'same' })
    const entry2 = makeEntry({ chatId: 'same', agentName: 'codex-cli' })
    store.set('same', entry1)
    store.set('same', entry2)
    expect(store.get('same')?.agentName).toBe('codex-cli')
  })

  it('keys() iterates all keys', () => {
    store.set('a', makeEntry({ chatId: 'a' }))
    store.set('b', makeEntry({ chatId: 'b' }))
    expect(Array.from(store.keys()).sort()).toEqual(['a', 'b'])
  })

  it('values() iterates all entries', () => {
    store.set('a', makeEntry({ chatId: 'a' }))
    store.set('b', makeEntry({ chatId: 'b' }))
    expect(Array.from(store.values()).map(e => e.chatId).sort()).toEqual(['a', 'b'])
  })

  it('init is a no-op', async () => {
    await expect(store.init()).resolves.toBeUndefined()
  })

  it('dispose clears all entries', async () => {
    store.set('a', makeEntry({ chatId: 'a' }))
    await store.dispose()
    expect(store.get('a')).toBeUndefined()
  })
})

// ===== FileSessionStore =====

describe('FileSessionStore', () => {
  let store: FileSessionStore
  let tmpDir: string
  let filePath: string

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `aibot-connect-test-${randomUUID()}`)
    filePath = join(tmpDir, 'sessions.json')
    store = new FileSessionStore({ filePath })
  })

  afterEach(async () => {
    await store.dispose()
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('returns undefined for unknown key', () => {
    expect(store.get('nonexistent')).toBeUndefined()
  })

  it('stores and retrieves an entry', async () => {
    await store.init()
    const entry = makeEntry()
    store.set(entry.chatId, entry)
    expect(store.get(entry.chatId)).toEqual(entry)
  })

  it('deletes an entry', async () => {
    await store.init()
    const entry = makeEntry()
    store.set(entry.chatId, entry)
    store.delete(entry.chatId)
    expect(store.get(entry.chatId)).toBeUndefined()
  })

  it('keys() and values() iterate entries', async () => {
    await store.init()
    store.set('a', makeEntry({ chatId: 'a' }))
    store.set('b', makeEntry({ chatId: 'b' }))
    expect(Array.from(store.keys()).sort()).toEqual(['a', 'b'])
    expect(Array.from(store.values()).map(e => e.chatId).sort()).toEqual(['a', 'b'])
  })

  it('persists sessions to file (waits for debounce flush)', async () => {
    await store.init()
    store.set('chat-1', makeEntry({ chatId: 'chat-1' }))

    // dispose triggers immediate flush
    await store.dispose()

    const raw = await readFile(filePath, 'utf-8')
    const entries: SessionEntry[] = JSON.parse(raw)
    expect(entries).toHaveLength(1)
    expect(entries[0].chatId).toBe('chat-1')
  })

  it('loads sessions from file on init', async () => {
    // Write file first
    const entries: SessionEntry[] = [makeEntry({ chatId: 'preloaded' })]
    await mkdir(tmpDir, { recursive: true })
    await writeFile(filePath, JSON.stringify(entries), 'utf-8')

    const store2 = new FileSessionStore({ filePath })
    try {
      await store2.init()
      expect(store2.get('preloaded')?.chatId).toBe('preloaded')
    } finally {
      await store2.dispose()
    }
  })

  it('init survives missing directory/file (ENOENT)', async () => {
    await store.init()
    // Should not throw — just starts with empty map
    expect(store.get('anything')).toBeUndefined()
  })

  it('atomic write leaves no .tmp file after flush', async () => {
    await store.init()
    store.set('chat-1', makeEntry({ chatId: 'chat-1' }))
    await store.dispose()

    await expect(stat(`${filePath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
    const raw = await readFile(filePath, 'utf-8')
    expect(() => JSON.parse(raw)).not.toThrow()
  })

  it('cleans up .tmp file when rename fails', async () => {
    await store.init()
    store.set('chat-1', makeEntry({ chatId: 'chat-1' }))

    // Make rename fail by replacing the target with a directory of the same name —
    // rename(file, dir-with-same-name) fails with EISDIR/ENOTDIR on POSIX
    // First remove the target if any, then create a directory there
    const { rm, mkdir: mkdirFs } = await import('node:fs/promises')
    await rm(filePath, { force: true })
    await mkdirFs(filePath) // now filePath is a directory

    // dispose triggers flushPersist; rename(tmpPath, filePath-as-directory) should fail
    await store.dispose()

    // tmp file should be cleaned up despite rename failure
    await expect(stat(`${filePath}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })

    // cleanup the directory so afterEach can rm the tmpDir
    await rm(filePath, { recursive: true, force: true })
  })

  it('init quarantines corrupted JSON file and starts empty', async () => {
    await mkdir(tmpDir, { recursive: true })
    await writeFile(filePath, '{ not valid json', 'utf-8')

    const store2 = new FileSessionStore({ filePath })
    try {
      await store2.init()
      expect(store2.get('anything')).toBeUndefined()

      const dirEntries = await readdir(tmpDir)
      expect(dirEntries.some(name => name.startsWith('sessions.json.corrupt-'))).toBe(true)
    } finally {
      await store2.dispose()
    }
  })

  it('dispose awaits in-flight flush even if writeFile is slow', async () => {
    vi.useFakeTimers()
    try {
      await store.init()
      store.set('chat-1', makeEntry({ chatId: 'chat-1' }))
      // persistTimer is scheduled on the fake clock.
      // Advance to fire it — this sets inFlightFlush and clears persistTimer.
      await vi.advanceTimersByTimeAsync(5000)
      // At this point: persistTimer is null; inFlightFlush is non-null and resolved
      // (or near-resolved, since fake timers also drain microtasks).
      // dispose must reach the standalone `if (this.inFlightFlush)` branch.
      await store.dispose()
    } finally {
      vi.useRealTimers()
    }

    const raw = await readFile(filePath, 'utf-8')
    const entries: SessionEntry[] = JSON.parse(raw)
    expect(entries).toHaveLength(1)
    expect(entries[0].chatId).toBe('chat-1')
  })

  it('dispose flushes pending persist when called before debounce fires', async () => {
    await store.init()
    store.set('chat-1', makeEntry({ chatId: 'chat-1' }))

    // Don't advance timers — call dispose immediately while persistTimer is pending
    await store.dispose()

    const raw = await readFile(filePath, 'utf-8')
    const entries: SessionEntry[] = JSON.parse(raw)
    expect(entries).toHaveLength(1)
    expect(entries[0].chatId).toBe('chat-1')
  })

  it('dispose does not lose data when persistTimer fires during an in-flight flush', async () => {
    vi.useFakeTimers()
    try {
      await store.init()

      // First mutation → schedules persistTimer
      store.set('chat-1', makeEntry({ chatId: 'chat-1' }))

      // Advance 5 s: timer fires → persistTimer = null, inFlightFlush is created
      await vi.advanceTimersByTimeAsync(5_000)

      // Second mutation while flush may still be in flight → schedules a new persistTimer
      store.set('chat-2', makeEntry({ chatId: 'chat-2' }))

      // dispose: both persistTimer (new) and inFlightFlush (old) may be active
      await store.dispose()
    } finally {
      vi.useRealTimers()
    }

    const raw = await readFile(filePath, 'utf-8')
    const entries: SessionEntry[] = JSON.parse(raw)
    expect(entries.map((e) => e.chatId).sort()).toEqual(['chat-1', 'chat-2'])
  })
})
