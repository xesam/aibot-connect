import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { log, type Logger } from '../logger.js'
import { toErrorMessage } from '../utils.js'

// ===== 会话条目 =====

export interface SessionEntry {
  chatId: string
  agentName: string
  agentSessionId: string
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd: number
  lastActiveTime: number
  createdAt: number
}

// ===== 存储接口 =====

export interface SessionStore {
  get(chatId: string): SessionEntry | undefined
  set(chatId: string, entry: SessionEntry): void
  delete(chatId: string): void
  keys(): IterableIterator<string>
  values(): IterableIterator<SessionEntry>
  init(): Promise<void>
  dispose(): Promise<void>
}

// ===== 内存存储 =====

export class MemorySessionStore implements SessionStore {
  private sessions = new Map<string, SessionEntry>()

  get(chatId: string): SessionEntry | undefined {
    return this.sessions.get(chatId)
  }

  set(chatId: string, entry: SessionEntry): void {
    this.sessions.set(chatId, entry)
  }

  delete(chatId: string): void {
    this.sessions.delete(chatId)
  }

  keys(): IterableIterator<string> {
    return this.sessions.keys()
  }

  values(): IterableIterator<SessionEntry> {
    return this.sessions.values()
  }

  async init(): Promise<void> {}

  async dispose(): Promise<void> {
    this.sessions.clear()
  }
}

// ===== 文件存储 =====

export interface FileSessionStoreOptions {
  /** sessions.json 文件路径 */
  filePath: string
  /** 会话过期分钟数，默认 480（8 小时） */
  sessionTimeoutMin?: number
  /** 日志记录器；默认全局 log */
  logger?: Logger
}

export class FileSessionStore implements SessionStore {
  private sessions = new Map<string, SessionEntry>()
  private filePath: string
  private sessionTimeoutMin: number
  private readonly sessionTimeoutMs: number
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private inFlightFlush: Promise<void> | null = null
  private logger: Logger

  constructor(options: FileSessionStoreOptions) {
    this.filePath = options.filePath
    this.sessionTimeoutMin = options.sessionTimeoutMin ?? 480
    this.sessionTimeoutMs = this.sessionTimeoutMin * 60 * 1000
    this.logger = options.logger ?? log
  }

  get(chatId: string): SessionEntry | undefined {
    return this.sessions.get(chatId)
  }

  set(chatId: string, entry: SessionEntry): void {
    this.sessions.set(chatId, entry)
    this.schedulePersist()
  }

  delete(chatId: string): void {
    this.sessions.delete(chatId)
    this.schedulePersist()
  }

  keys(): IterableIterator<string> {
    return this.sessions.keys()
  }

  values(): IterableIterator<SessionEntry> {
    return this.sessions.values()
  }

  async init(): Promise<void> {
    const dirPath = dirname(this.filePath)
    await mkdir(dirPath, { recursive: true })

    try {
      const raw = await readFile(this.filePath, 'utf-8')
      const entries: SessionEntry[] = JSON.parse(raw)
      for (const entry of entries) {
        this.sessions.set(entry.chatId, entry)
      }
    } catch (error) {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        // first-time start; nothing to load
      } else if (err instanceof SyntaxError) {
        const quarantinePath = `${this.filePath}.corrupt-${Date.now()}`
        this.logger.error(`[FileSessionStore] Corrupted sessions file, quarantining to ${quarantinePath}: ${toErrorMessage(error)}`)
        await rename(this.filePath, quarantinePath).catch((renameErr) => {
          this.logger.error(`[FileSessionStore] Failed to quarantine corrupted file: ${toErrorMessage(renameErr)}`)
        })
      } else {
        this.logger.error(`[FileSessionStore] Failed to load sessions: ${toErrorMessage(error)}`)
      }
    }

    if (this.sessionTimeoutMin > 0) {
      this.cleanupTimer = setInterval(() => {
        if (this.sessions.size === 0) return
        const cutoff = Date.now() - this.sessionTimeoutMs
        let deleted = 0
        for (const [chatId, entry] of this.sessions) {
          if (entry.lastActiveTime < cutoff) {
            this.sessions.delete(chatId)
            deleted++
          }
        }
        if (deleted > 0) {
          this.schedulePersist()
          this.logger.info(`[FileSessionStore] Cleaned up ${deleted} expired session(s)`)
        }
      }, 60_000)

      this.cleanupTimer.unref()
    }
  }

  async dispose(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
      const prev = this.inFlightFlush ?? Promise.resolve()
      this.inFlightFlush = prev.then(() => this.flushPersist()).finally(() => {
        this.inFlightFlush = null
      })
    }
    if (this.inFlightFlush) {
      await this.inFlightFlush
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.inFlightFlush = this.flushPersist().finally(() => {
        this.inFlightFlush = null
      })
    }, 5_000)
  }

  /**
   * Persist sessions atomically: write to tmp, then rename.
   * On crash between write and rename, the .tmp file is orphaned but harmless —
   * init() reads filePath, never tmpPath. Operators may safely delete stale .tmp files.
   */
  private async flushPersist(): Promise<void> {
    const tmpPath = `${this.filePath}.tmp`
    try {
      const entries = Array.from(this.sessions.values())
      await writeFile(tmpPath, JSON.stringify(entries, null, 2), 'utf-8')
      await rename(tmpPath, this.filePath)
    } catch (error) {
      this.logger.error(`[FileSessionStore] Failed to persist sessions: ${toErrorMessage(error)}`)
      await unlink(tmpPath).catch(() => {})
    }
  }
}
