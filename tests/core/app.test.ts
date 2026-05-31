import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanupStaleStates } from '../../src/core/app.js'
import type { ChannelAdapter, ChannelCallbacks } from '../../src/channel/types.js'

function createDeferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

// A simple stub ChannelAdapter that can control when start resolves
class ControllableAdapter implements ChannelAdapter {
  readonly name = 'stub'
  private startDeferred = createDeferred()
  private _connectCalled = false
  private _disconnectCalled = false

  get connectCalled() { return this._connectCalled }
  get disconnectCalled() { return this._disconnectCalled }

  resolveStart() { this.startDeferred.resolve() }
  rejectStart(err: Error) { this.startDeferred.reject(err) }

  async start(_callbacks: ChannelCallbacks): Promise<void> {
    this._connectCalled = true
    await this.startDeferred.promise
  }

  async stop(): Promise<void> {
    this._disconnectCalled = true
  }
}

describe('createApp', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('waits for the adapter to become ready before start resolves', async () => {
    const logInfoMock = vi.fn()

    vi.doMock('../../src/logger.js', () => {
      const log = {
        info: (...args: unknown[]) => logInfoMock(...args),
        error: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
      }
      return {
        setLogLevel: vi.fn(),
        createLogger: () => log,
        log,
      }
    })

    const { createApp } = await import('../../src/core/app.js')
    const adapter = new ControllableAdapter()
    const app = createApp({ adapter, singleInstance: false })

    let resolved = false
    const startPromise = app.start().then(() => {
      resolved = true
    })

    await Promise.resolve()

    expect(adapter.connectCalled).toBe(true)
    expect(resolved).toBe(false)
    expect(logInfoMock).not.toHaveBeenCalledWith(expect.stringContaining('Service started'))

    adapter.resolveStart()
    await startPromise

    expect(resolved).toBe(true)
    expect(logInfoMock).toHaveBeenCalledWith('[App] Service started (channel: stub)')
    expect(adapter.disconnectCalled).toBe(false)
  })

  it('does not leak a timer when start() is called twice without an intervening stop()', async () => {
    vi.doMock('../../src/logger.js', () => {
      const log = {
        info: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      }
      return {
        setLogLevel: vi.fn(),
        createLogger: () => log,
        log,
      }
    })

    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')

    const { createApp } = await import('../../src/core/app.js')

    // Use a simple always-resolves adapter
    const adapter: ChannelAdapter = {
      name: 'stub',
      async start() {},
      async stop() {},
    }
    const app = createApp({ adapter, singleInstance: false })

    await app.start()
    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    expect(clearIntervalSpy).not.toHaveBeenCalled()

    // Second start without stop — must clear the first timer before creating a new one.
    await app.start()
    expect(setIntervalSpy).toHaveBeenCalledTimes(2)
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)

    setIntervalSpy.mockRestore()
    clearIntervalSpy.mockRestore()
  })

  it('releases the PID lock if startup fails while waiting for readiness', async () => {
    const startupError = new Error('auth failed')
    const acquireLockMock = vi.fn().mockResolvedValue(undefined)
    const releaseLockMock = vi.fn().mockResolvedValue(undefined)
    const logInfoMock = vi.fn()

    vi.doMock('../../src/logger.js', () => {
      const log = {
        info: (...args: unknown[]) => logInfoMock(...args),
        error: vi.fn(),
        debug: vi.fn(),
        warn: vi.fn(),
      }
      return {
        setLogLevel: vi.fn(),
        createLogger: () => log,
        log,
      }
    })

    vi.doMock('../../src/lock.js', () => ({
      acquireLock: acquireLockMock,
      releaseLock: releaseLockMock,
    }))

    const { createApp } = await import('../../src/core/app.js')
    const adapter: ChannelAdapter = {
      name: 'stub',
      async start() { throw startupError },
      async stop() {},
    }
    const app = createApp({ adapter })

    await expect(app.start()).rejects.toThrow('auth failed')

    expect(acquireLockMock).toHaveBeenCalledTimes(1)
    expect(releaseLockMock).toHaveBeenCalledTimes(1)
    expect(logInfoMock).not.toHaveBeenCalledWith(expect.stringContaining('Service started'))
  })
})

describe('app API typing', () => {
  it('onMessage handler receives MessageContext (replyStream available)', async () => {
    const m: import('../../src/types.js').MessageHandler = async (ctx) => {
      // ctx.replyStream must compile (MessageContext has it)
      ctx.replyStream()
      // ctx.text must compile
      void ctx.text
    }
    expect(typeof m).toBe('function')
  })

  it('onEvent handler receives EventContext (reply only)', async () => {
    const e: import('../../src/types.js').EventHandler = async (ctx) => {
      await ctx.reply('welcome')
      // ctx.replyStream would NOT compile — but we can't test "doesn't compile" at runtime
    }
    expect(typeof e).toBe('function')
  })
})

describe('cleanupStaleStates', () => {
  it('removes entries older than retentionMs', () => {
    const map = new Map<string, { state: Record<string, unknown>; lastTouchedAt: number }>()
    const now = 10_000_000
    map.set('fresh', { state: { a: 1 }, lastTouchedAt: now - 1000 })
    map.set('stale-1', { state: { a: 2 }, lastTouchedAt: now - 30_000 })
    map.set('stale-2', { state: { a: 3 }, lastTouchedAt: now - 60_000 })

    const removed = cleanupStaleStates(map, 10_000, now)
    expect(removed).toBe(2)
    expect(map.has('fresh')).toBe(true)
    expect(map.has('stale-1')).toBe(false)
    expect(map.has('stale-2')).toBe(false)
  })

  it('keeps everything when retentionMs is 0 or negative (disabled)', () => {
    const map = new Map<string, { state: Record<string, unknown>; lastTouchedAt: number }>()
    map.set('a', { state: {}, lastTouchedAt: 0 })
    expect(cleanupStaleStates(map, 0, 999_999)).toBe(0)
    expect(map.has('a')).toBe(true)
    expect(cleanupStaleStates(map, -1, 999_999)).toBe(0)
    expect(map.has('a')).toBe(true)
  })

  it('returns 0 when map is empty', () => {
    const map = new Map<string, { state: Record<string, unknown>; lastTouchedAt: number }>()
    expect(cleanupStaleStates(map, 1000)).toBe(0)
  })
})
