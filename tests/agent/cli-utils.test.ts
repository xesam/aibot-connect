import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PassThrough } from 'node:stream'
import type { AgentMessage } from '../../src/agent/types.js'

// ============================================================
// Mock setup — use PassThrough stream for stdout
// ============================================================

const mockKillCalls: NodeJS.Signals[] = []
let mockStdinEnded = false
let mockStdinData: string[] = []
let mockExitCode: number | null = null
let mockSignalCode: NodeJS.Signals | null = null
let mockCloseHandler: ((code: number | null) => void) | null = null
let mockErrorHandler: ((err: Error) => void) | null = null
let mockExitHandler: (() => void) | null = null
let mockStdout: PassThrough | null = null
let mockStderrHandler: ((data: Buffer) => void) | null = null
let mockAutoCloseOnKill = true

function resetMock() {
  mockKillCalls.length = 0
  mockStdinEnded = false
  mockStdinData = []
  mockExitCode = null
  mockSignalCode = null
  mockCloseHandler = null
  mockErrorHandler = null
  mockExitHandler = null
  mockStdout = null
  mockStderrHandler = null
  mockAutoCloseOnKill = true
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn((_command: string, _args: string[], _opts: Record<string, unknown>) => {
    mockStdout = new PassThrough()
    return {
      get exitCode() { return mockExitCode },
      get signalCode() { return mockSignalCode },
      stdin: {
        write: (data: string) => { mockStdinData.push(data); return true },
        end: () => { mockStdinEnded = true },
        on: (_event: string, _handler: (...args: any[]) => void) => {},
      },
      stdout: mockStdout,
      stderr: {
        on: (_event: string, handler: (data: Buffer) => void) => { mockStderrHandler = handler },
      },
      on: (event: string, handler: (...args: any[]) => void) => {
        if (event === 'close') mockCloseHandler = handler as (code: number | null) => void
        if (event === 'error') mockErrorHandler = handler as (err: Error) => void
      },
      once: (event: string, handler: (...args: any[]) => void) => {
        if (event === 'exit') mockExitHandler = handler as () => void
      },
      kill: (signal?: NodeJS.Signals) => {
        mockKillCalls.push(signal ?? 'SIGTERM')
        if (!mockAutoCloseOnKill) return
        if (mockExitCode === null) mockExitCode = 1
        // End stdout so readline's for-await loop unblocks
        if (mockStdout) mockStdout.push(null)
        if (mockCloseHandler) mockCloseHandler(mockExitCode)
      },
    }
  }),
}))

import { runCliAgent, SIGTERM_GRACE_MS } from '../../src/agent/cli-utils.js'

// ============================================================
// Helpers
// ============================================================

function emitStdoutLine(line: string) {
  if (mockStdout) mockStdout.write(line + '\n')
}

function closeChild(code: number | null) {
  mockExitCode = code
  // End stdout stream first so readline's for-await loop exits
  if (mockStdout) mockStdout.push(null)
  if (mockCloseHandler) mockCloseHandler(code)
}

async function consume<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = []
  for await (const item of iter) items.push(item)
  return items
}

// ============================================================
// Tests
// ============================================================

describe('runCliAgent', () => {
  beforeEach(() => {
    resetMock()
    vi.clearAllMocks()
  })

  describe('exit code 0 → done', () => {
    it('yields done when child exits with code 0', async () => {
      const stream = runCliAgent({
        command: 'echo', args: [], cwd: '/tmp', stdin: '',
        parseLine: () => null,
      })
      const result = consume(stream)
      // Wait for readline to set up
      await new Promise(r => setTimeout(r, 5))
      closeChild(0)
      const msgs = await result
      expect(msgs).toEqual([{ type: 'done' }])
    })
  })

  describe('exit code non-zero → error', () => {
    it('yields error with stderr when child exits with code 1', async () => {
      const stream = runCliAgent({
        command: 'bad', args: [], cwd: '/tmp', stdin: '',
        parseLine: () => null,
      })
      const result = consume(stream)
      await new Promise(r => setTimeout(r, 5))
      if (mockStderrHandler) mockStderrHandler(Buffer.from('command not found'))
      closeChild(1)
      const msgs = await result
      expect(msgs).toEqual([{ type: 'error', message: 'command not found' }])
    })

    it('yields fallback error when stderr is empty', async () => {
      const stream = runCliAgent({
        command: 'bad', args: [], cwd: '/tmp', stdin: '',
        parseLine: () => null,
      })
      const result = consume(stream)
      await new Promise(r => setTimeout(r, 5))
      closeChild(2)
      const msgs = await result
      expect(msgs).toEqual([{ type: 'error', message: 'bad exited with code 2' }])
    })
  })

  describe('stdout parsing', () => {
    it('yields parsed text messages from stdout lines', async () => {
      const stream = runCliAgent({
        command: 'cmd', args: [], cwd: '/tmp', stdin: 'hi',
        parseLine: (line) => line ? { type: 'text', text: `>> ${line}` } : null,
      })
      const result = consume(stream)
      await new Promise(r => setTimeout(r, 5))
      emitStdoutLine('line1')
      emitStdoutLine('line2')
      closeChild(0)
      const msgs = await result
      expect(msgs.slice(0, 2)).toEqual([
        { type: 'text', text: '>> line1' },
        { type: 'text', text: '>> line2' },
      ])
      expect(msgs[msgs.length - 1]).toEqual({ type: 'done' })
    })

    it('skips lines that parse to null', async () => {
      const calls: string[] = []
      const stream = runCliAgent({
        command: 'cmd', args: [], cwd: '/tmp', stdin: '',
        parseLine: (line) => { calls.push(line); return null },
      })
      const result = consume(stream)
      await new Promise(r => setTimeout(r, 5))
      emitStdoutLine('skip1')
      emitStdoutLine('skip2')
      closeChild(0)
      const msgs = await result
      expect(calls).toEqual(['skip1', 'skip2'])
      expect(msgs).toEqual([{ type: 'done' }])
    })

    it('skips empty/whitespace lines', async () => {
      const calls: string[] = []
      const stream = runCliAgent({
        command: 'cmd', args: [], cwd: '/tmp', stdin: '',
        parseLine: (line) => { calls.push(line); return null },
      })
      const result = consume(stream)
      await new Promise(r => setTimeout(r, 5))
      emitStdoutLine('   ')
      emitStdoutLine('')
      emitStdoutLine('real')
      closeChild(0)
      await result
      expect(calls).toEqual(['real'])
    })

    it('handles parseLine returning an array', async () => {
      const stream = runCliAgent({
        command: 'cmd', args: [], cwd: '/tmp', stdin: '',
        parseLine: () => [
          { type: 'text', text: 'msg1' },
          { type: 'text', text: 'msg2' },
        ] as AgentMessage[],
      })
      const result = consume(stream)
      await new Promise(r => setTimeout(r, 5))
      emitStdoutLine('x')
      closeChild(0)
      const msgs = await result
      expect(msgs[0]).toEqual({ type: 'text', text: 'msg1' })
      expect(msgs[1]).toEqual({ type: 'text', text: 'msg2' })
      expect(msgs[2]).toEqual({ type: 'done' })
    })
  })

  describe('stdin handling', () => {
    it('writes stdin and ends', async () => {
      const stream = runCliAgent({
        command: 'echo', args: [], cwd: '/tmp', stdin: 'hello world',
        parseLine: () => null,
      })
      const result = consume(stream)
      await new Promise(r => setTimeout(r, 5))
      closeChild(0)
      await result
      expect(mockStdinData).toEqual(['hello world'])
      expect(mockStdinEnded).toBe(true)
    })
  })

  describe('abort handling', () => {
    it('yields done (not error) when abort caused the non-zero exit', async () => {
      const ac = new AbortController()
      const stream = runCliAgent({
        command: 'long', args: [], cwd: '/tmp', stdin: '',
        parseLine: () => null,
        abortController: ac,
      })
      const result = consume(stream)
      await new Promise(r => setTimeout(r, 5))
      ac.abort()
      await new Promise(r => setTimeout(r, 5))
      const msgs = await result
      // Intentional abort: last message must be done, not error
      expect(msgs[msgs.length - 1]).toEqual({ type: 'done' })
    })

    it('calls kill(SIGTERM) when abortController is signaled', async () => {
      const ac = new AbortController()
      const stream = runCliAgent({
        command: 'long', args: [], cwd: '/tmp', stdin: '',
        parseLine: () => null,
        abortController: ac,
      })
      const result = consume(stream)
      await new Promise(r => setTimeout(r, 5))
      ac.abort()
      await new Promise(r => setTimeout(r, 5))
      await result
      expect(mockKillCalls).toEqual(['SIGTERM'])
    })

    it('removes abort listener in finally block', async () => {
      const ac = new AbortController()
      const removeSpy = vi.spyOn(ac.signal, 'removeEventListener')
      const stream = runCliAgent({
        command: 'cmd', args: [], cwd: '/tmp', stdin: '',
        parseLine: () => null,
        abortController: ac,
      })
      const result = consume(stream)
      await new Promise(r => setTimeout(r, 5))
      closeChild(0)
      await result
      expect(removeSpy).toHaveBeenCalledWith('abort', expect.any(Function))
    })
  })

  describe('cleanup', () => {
    it('does not kill in finally when child already closed (processExited guard)', async () => {
      const stream = runCliAgent({
        command: 'stuck', args: [], cwd: '/tmp', stdin: '',
        parseLine: () => null,
      })
      const result = consume(stream)
      await new Promise(r => setTimeout(r, 5))
      // close fires → processExited = true; finally-block killTree is a no-op
      closeChild(null)
      await result
      expect(mockKillCalls).toEqual([])
    })
  })
})

describe('runCliAgent — robustness', () => {
  beforeEach(() => {
    resetMock()
    vi.clearAllMocks()
  })

  it('yields error message when spawn emits error event (ENOENT)', async () => {
    const stream = runCliAgent({
      command: 'doesnotexist',
      args: [],
      cwd: '/tmp',
      stdin: '',
      parseLine: () => null,
    })
    const result = consume(stream)

    // Wait for the iterator to register handlers
    await new Promise(r => setTimeout(r, 5))

    const enoentError = Object.assign(new Error('spawn doesnotexist ENOENT'), { code: 'ENOENT' })
    if (mockErrorHandler) mockErrorHandler(enoentError)
    // child must close to let the for-await loop exit
    if (mockStdout) mockStdout.push(null)
    if (mockCloseHandler) mockCloseHandler(null)

    const messages = await result
    expect(messages).toHaveLength(1)
    expect(messages[0].type).toBe('error')
    expect((messages[0] as Extract<AgentMessage, { type: 'error' }>).message).toContain('ENOENT')
  })

  it('caps stderr at the configured limit and marks truncated', async () => {
    const stream = runCliAgent({
      command: 'fake',
      args: [],
      cwd: '/tmp',
      stdin: '',
      parseLine: () => null,
    })
    const result = consume(stream)

    await new Promise(r => setTimeout(r, 5))

    // Emit 1.5 MB of stderr data
    const chunk = Buffer.alloc(500_000, 'X')
    if (mockStderrHandler) mockStderrHandler(chunk)
    if (mockStderrHandler) mockStderrHandler(chunk)
    if (mockStderrHandler) mockStderrHandler(chunk)

    // Exit non-zero so we get the stderr-as-error message path
    closeChild(1)

    const messages = await result
    const errMsg = messages.find(m => m.type === 'error') as Extract<AgentMessage, { type: 'error' }>
    expect(errMsg).toBeDefined()
    // message length should be near 1MB + truncation marker — not 1.5MB
    expect(errMsg.message.length).toBeLessThan(1_100_000)
    expect(errMsg.message).toContain('[stderr truncated]')
  })

  it('first kill signal sent on abort is SIGTERM', async () => {
    const ac = new AbortController()
    const stream = runCliAgent({
      command: 'fake', args: [], cwd: '/tmp', stdin: '',
      parseLine: () => null,
      abortController: ac,
    })
    const result = consume(stream)
    await new Promise(r => setTimeout(r, 5))
    ac.abort()
    await new Promise(r => setTimeout(r, 5))
    await result
    expect(mockKillCalls[0]).toBe('SIGTERM')
  })

  it('finally kill is suppressed once child has already exited (processExited guard)', async () => {
    const stream = runCliAgent({
      command: 'fake', args: [], cwd: '/tmp', stdin: '',
      parseLine: () => null,
    })
    const result = consume(stream)
    await new Promise(r => setTimeout(r, 5))

    // child exits cleanly — close fires, processExited becomes true
    mockExitCode = 0
    if (mockStdout) mockStdout.push(null)
    if (mockCloseHandler) mockCloseHandler(0)

    await result

    // The finally block calls killTree, but processExited is true so no kill is sent
    expect(mockKillCalls).toEqual([])
  })

  it('killTree is a no-op when signalCode is set', async () => {
    vi.useFakeTimers()
    try {
      mockAutoCloseOnKill = false

      const ac = new AbortController()
      const stream = runCliAgent({
        command: 'fake', args: [], cwd: '/tmp', stdin: '',
        parseLine: () => null,
        abortController: ac,
      })
      const consumePromise = consume(stream)

      await Promise.resolve()
      await Promise.resolve()

      // First abort: sends SIGTERM
      ac.abort()
      expect(mockKillCalls).toEqual(['SIGTERM'])

      // Simulate OS killing via signal — signalCode is now set
      mockSignalCode = 'SIGTERM' as NodeJS.Signals

      // Advance past grace period; SIGKILL guard should see signalCode and bail
      vi.advanceTimersByTime(SIGTERM_GRACE_MS + 100)
      expect(mockKillCalls).toEqual(['SIGTERM']) // no SIGKILL added

      // Clean up: let the iterator finish
      mockAutoCloseOnKill = true
      if (mockStdout) mockStdout.push(null)
      if (mockCloseHandler) mockCloseHandler(null)
      vi.runAllTimers()

      await consumePromise
    } finally {
      vi.useRealTimers()
    }
  })

  it('escalates SIGTERM to SIGKILL after grace period when child does not exit', async () => {
    vi.useFakeTimers()
    try {
      // Configure mock to NOT auto-close on kill (simulate non-responsive child)
      mockAutoCloseOnKill = false

      const ac = new AbortController()
      const stream = runCliAgent({
        command: 'stubborn', args: [], cwd: '/tmp', stdin: '',
        parseLine: () => null,
        abortController: ac,
      })
      // Don't await consume yet — we need to inspect kill calls before the loop exits
      const consumePromise = (async () => {
        const msgs: AgentMessage[] = []
        for await (const m of stream) msgs.push(m)
        return msgs
      })()

      // Advance microtasks so the iterator wires up listeners
      await Promise.resolve()
      await Promise.resolve()

      ac.abort()

      // SIGTERM should have been sent immediately
      expect(mockKillCalls).toContain('SIGTERM')
      const sigtermCount = mockKillCalls.filter(s => s === 'SIGTERM').length
      expect(sigtermCount).toBeGreaterThanOrEqual(1)
      expect(mockKillCalls).not.toContain('SIGKILL')

      // Advance past the grace period
      vi.advanceTimersByTime(SIGTERM_GRACE_MS + 100)

      // SIGKILL should now have been queued
      expect(mockKillCalls).toContain('SIGKILL')

      // Now let the iterator complete by re-enabling auto-close and closing the child
      mockAutoCloseOnKill = true
      if (mockStdout) mockStdout.push(null)
      if (mockCloseHandler) mockCloseHandler(null)

      // Drain any remaining timers (the finally-block killTree schedules another setTimeout)
      vi.runAllTimers()

      await consumePromise
    } finally {
      vi.useRealTimers()
    }
  })
})
