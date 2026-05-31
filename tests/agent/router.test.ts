import { describe, it, expect, beforeEach, vi } from 'vitest'
import { RouterAgent } from '../../src/agent/router.js'
import { MemorySessionStore } from '../../src/agent/session-store.js'
import type { Agent, AgentOptions, AgentMessage, AgentStream } from '../../src/agent/types.js'
import type { MessageContext, EventContext, ReplyStream } from '../../src/types.js'

// ============================================================
// Mock helpers
// ============================================================

interface StubReplyStream extends ReplyStream {
  _chunks: string[]
  _state: 'idle' | 'streaming' | 'ended' | 'failed'
}

function makeReplyStream(): StubReplyStream {
  const s: StubReplyStream = {
    _chunks: [],
    _state: 'idle',
    append(text: string) {
      if (s._state === 'idle') s._state = 'streaming'
      s._chunks.push(text)
    },
    async end() {
      s._state = 'ended'
    },
    async error(_message: string) {
      s._state = 'failed'
    },
    getState() {
      return s._state
    },
  }
  return s
}

interface StubCtx {
  chatId: string
  userId: string
  traceId: string
  conversationKey: string
  channelName: string
  kind: 'message' | 'command' | 'event'
  text: string
  command?: { name: string; args?: string; raw: string }
  state: Record<string, unknown>
  _replies: string[]
  _rs: StubReplyStream | null
}

function makeMsgCtx(overrides: Partial<StubCtx> = {}): StubCtx & MessageContext {
  const s: StubCtx = {
    chatId: 'chat-1',
    userId: 'user-1',
    traceId: 'trace-1',
    conversationKey: 'key-1',
    channelName: 'stub',
    kind: 'message',
    text: 'hello',
    state: {},
    _replies: [],
    _rs: null,
    ...overrides,
  }

  return {
    get chatId() { return s.chatId },
    get userId() { return s.userId },
    get traceId() { return s.traceId },
    get conversationKey() { return s.conversationKey },
    get channelName() { return s.channelName },
    get kind() { return s.kind },
    get text() { return s.text },
    get command() { return s.command },
    get _replies() { return s._replies },
    get _rs() { return s._rs },
    state: s.state,
    msgType: 'text' as const,
    raw: {} as any,
    async reply(text: string) { s._replies.push(text) },
    replyStream(): ReplyStream {
      if (!s._rs) s._rs = makeReplyStream()
      return s._rs
    },
  } as unknown as MessageContext
}

function makeEventCtx(overrides: Partial<StubCtx> = {}): StubCtx & EventContext {
  const s: StubCtx = {
    chatId: 'chat-1',
    userId: 'user-1',
    traceId: 'trace-1',
    conversationKey: 'key-1',
    channelName: 'stub',
    kind: 'event',
    text: '',
    state: {},
    _replies: [],
    _rs: null,
    ...overrides,
  }

  return {
    get chatId() { return s.chatId },
    get userId() { return s.userId },
    get traceId() { return s.traceId },
    get conversationKey() { return s.conversationKey },
    get channelName() { return s.channelName },
    get kind() { return s.kind as 'event' },
    get command() { return undefined },
    get _replies() { return s._replies },
    state: s.state,
    raw: {} as any,
    async reply(text: string) { s._replies.push(text) },
  } as unknown as EventContext
}

function makeMockAgent(name: string, msgs?: AgentMessage[]): Agent {
  async function* stream(): AgentStream {
    for (const m of msgs ?? []) yield m
  }
  return { name, query: vi.fn(() => stream()) }
}

// ============================================================
// Tests
// ============================================================

describe('RouterAgent', () => {
  describe('constructor', () => {
    it('throws when defaultAgent is not in agents', () => {
      expect(() => {
        new RouterAgent({
          agents: { claude: makeMockAgent('claude') },
          defaultAgent: 'codex',
          sessionStore: new MemorySessionStore(),
        })
      }).toThrow('defaultAgent "codex" not found')
    })

    it('creates successfully with valid config', () => {
      const router = new RouterAgent({
        agents: { claude: makeMockAgent('claude') },
        defaultAgent: 'claude',
        sessionStore: new MemorySessionStore(),
      })
      expect(router).toBeInstanceOf(RouterAgent)
    })
  })

  describe('handleEvent', () => {
    it('replies with welcome message including displayName', async () => {
      const router = new RouterAgent({
        agents: { claude: makeMockAgent('claude') },
        defaultAgent: 'claude',
        displayName: '小助手',
        sessionStore: new MemorySessionStore(),
      })
      const ctx = makeEventCtx()
      await router.handleEvent(ctx)
      expect(ctx._replies[0]).toContain('你好！我是 小助手。')
    })

    it('uses default name when displayName is not set', async () => {
      const router = new RouterAgent({
        agents: { claude: makeMockAgent('claude') },
        defaultAgent: 'claude',
        sessionStore: new MemorySessionStore(),
      })
      const ctx = makeEventCtx()
      await router.handleEvent(ctx)
      expect(ctx._replies[0]).toContain('你好！我是 aibot connect。')
    })

    it('lists available agents in welcome', async () => {
      const router = new RouterAgent({
        agents: {
          claude: makeMockAgent('claude'),
          codex: makeMockAgent('codex'),
        },
        defaultAgent: 'claude',
        sessionStore: new MemorySessionStore(),
      })
      const ctx = makeEventCtx()
      await router.handleEvent(ctx)
      expect(ctx._replies[0]).toContain('claude')
      expect(ctx._replies[0]).toContain('codex')
    })
  })

  describe('handle — framework commands', () => {
    it('handles /help via msgCtx.command', async () => {
      const router = new RouterAgent({
        agents: { claude: makeMockAgent('claude') },
        defaultAgent: 'claude',
        sessionStore: new MemorySessionStore(),
      })
      const ctx = makeMsgCtx({
        text: '/help',
        command: { name: 'help', raw: '/help' },
      })
      await router.handle(ctx)
      expect(ctx._replies[0]).toContain('/reset')
      expect(ctx._replies[0]).toContain('/stop')
      expect(ctx._replies[0]).toContain('/status')
    })

    it('handles /reset via msgCtx.command', async () => {
      const router = new RouterAgent({
        agents: { claude: makeMockAgent('claude') },
        defaultAgent: 'claude',
        sessionStore: new MemorySessionStore(),
      })
      const ctx = makeMsgCtx({
        text: '/reset',
        command: { name: 'reset', raw: '/reset' },
      })
      await router.handle(ctx)
      expect(ctx._replies[0]).toContain('会话已重置')
    })

    it('handles /stop via msgCtx.command', async () => {
      const router = new RouterAgent({
        agents: { claude: makeMockAgent('claude') },
        defaultAgent: 'claude',
        sessionStore: new MemorySessionStore(),
      })
      const ctx = makeMsgCtx({
        text: '/stop',
        command: { name: 'stop', raw: '/stop' },
      })
      await router.handle(ctx)
      expect(ctx._replies[0]).toContain('已中断')
    })

    it('handles /status with no session via msgCtx.command', async () => {
      const router = new RouterAgent({
        agents: { claude: makeMockAgent('claude') },
        defaultAgent: 'claude',
        sessionStore: new MemorySessionStore(),
      })
      const ctx = makeMsgCtx({
        text: '/status',
        command: { name: 'status', raw: '/status' },
      })
      await router.handle(ctx)
      expect(ctx._replies[0]).toContain('无活跃会话')
    })
  })

  describe('handle — self-parsed commands', () => {
    it('parses /help from message text (no ctx.command)', async () => {
      const router = new RouterAgent({
        agents: { claude: makeMockAgent('claude') },
        defaultAgent: 'claude',
        sessionStore: new MemorySessionStore(),
      })
      const ctx = makeMsgCtx({ text: '/help', command: undefined })
      await router.handle(ctx)
      expect(ctx._replies[0]).toContain('/reset')
    })

    it('parses /reset from message text', async () => {
      const router = new RouterAgent({
        agents: { claude: makeMockAgent('claude') },
        defaultAgent: 'claude',
        sessionStore: new MemorySessionStore(),
      })
      const ctx = makeMsgCtx({ text: '/reset', command: undefined })
      await router.handle(ctx)
      expect(ctx._replies[0]).toContain('会话已重置')
    })

    it('does NOT parse unknown /commands as built-in', async () => {
      // unknown commands should fall through to routing
      const router = new RouterAgent({
        agents: { claude: makeMockAgent('claude') },
        defaultAgent: 'claude',
        sessionStore: new MemorySessionStore(),
      })
      const ctx = makeMsgCtx({ text: '/unknown', command: undefined })
      await router.handle(ctx)
      // should NOT be command text, should be agent reply
      expect(ctx._replies[0]).toBeUndefined() // no direct reply
    })

    it('strips @mention prefix before command', async () => {
      const router = new RouterAgent({
        agents: { claude: makeMockAgent('claude') },
        defaultAgent: 'claude',
        sessionStore: new MemorySessionStore(),
      })
      const ctx = makeMsgCtx({ text: '@bot /help', command: undefined })
      await router.handle(ctx)
      expect(ctx._replies[0]).toContain('/reset')
    })
  })

  describe('handle — routing', () => {
    it('replies when agent is not found', async () => {
      const router = new RouterAgent({
        agents: { claude: makeMockAgent('claude') },
        defaultAgent: 'claude',
        route: () => 'unknown',
        sessionStore: new MemorySessionStore(),
      })
      const ctx = makeMsgCtx({ text: 'hello' })
      await router.handle(ctx)
      expect(ctx._replies[0]).toContain('未知 Agent')
    })

    it('streams text from agent to replyStream', async () => {
      const agent = makeMockAgent('claude', [
        { type: 'text', text: 'Hello world' },
        { type: 'done' },
      ])
      const router = new RouterAgent({
        agents: { claude: agent },
        defaultAgent: 'claude',
        sessionStore: new MemorySessionStore(),
      })
      const ctx = makeMsgCtx({ text: 'say hi' })
      await router.handle(ctx)
      const rs = ctx._rs!
      expect(rs._chunks).toEqual(['Hello world'])
      expect(rs._state).toBe('ended')
    })

    it('replies （无输出） when agent produces no text', async () => {
      const agent = makeMockAgent('claude', [
        { type: 'done' },
      ])
      const router = new RouterAgent({
        agents: { claude: agent },
        defaultAgent: 'claude',
        sessionStore: new MemorySessionStore(),
      })
      const ctx = makeMsgCtx({ text: 'say nothing' })
      await router.handle(ctx)
      expect(ctx._replies[0]).toContain('无输出')
    })

    it('streams error when agent yields error before text', async () => {
      const agent = makeMockAgent('claude', [
        { type: 'error', message: 'something broke' },
      ])
      const router = new RouterAgent({
        agents: { claude: agent },
        defaultAgent: 'claude',
        sessionStore: new MemorySessionStore(),
      })
      const ctx = makeMsgCtx({ text: 'fail' })
      await router.handle(ctx)
      expect(ctx._replies[0]).toContain('出错了')
      expect(ctx._replies[0]).toContain('something broke')
    })

    it('sends error via replyStream when stream has already started', async () => {
      const agent = makeMockAgent('claude', [
        { type: 'text', text: 'partial...' },
        { type: 'error', message: 'mid-stream error' },
      ])
      const router = new RouterAgent({
        agents: { claude: agent },
        defaultAgent: 'claude',
        sessionStore: new MemorySessionStore(),
      })
      const ctx = makeMsgCtx({ text: 'fail mid' })
      await router.handle(ctx)
      const rs = ctx._rs!
      expect(rs._chunks).toEqual(['partial...'])
      expect(rs._state).toBe('failed')
    })

    it('records session on agent session message', async () => {
      const agent = makeMockAgent('claude', [
        { type: 'session', sessionId: 'sess-abc' },
        { type: 'text', text: 'ok' },
        { type: 'done' },
      ])
      const store = new MemorySessionStore()
      const router = new RouterAgent({
        agents: { claude: agent },
        defaultAgent: 'claude',
        sessionStore: store,
      })
      const ctx = makeMsgCtx({ text: 'hello' })
      await router.handle(ctx)
      expect(store.get('chat-1')?.agentSessionId).toBe('sess-abc')
    })

    it('clears stale session on agent error', async () => {
      const store = new MemorySessionStore()
      // pre-populate a stale session
      store.set('chat-1', {
        chatId: 'chat-1',
        agentName: 'claude',
        agentSessionId: 'sess-old',
        totalInputTokens: 10,
        totalOutputTokens: 5,
        totalCostUsd: 0,
        lastActiveTime: Date.now(),
        createdAt: Date.now(),
      })

      const agent = makeMockAgent('claude', [
        { type: 'error', message: 'session expired' },
      ])
      const router = new RouterAgent({
        agents: { claude: agent },
        defaultAgent: 'claude',
        sessionStore: store,
      })
      const ctx = makeMsgCtx({ text: 'resume failed' })
      await router.handle(ctx)
      expect(store.get('chat-1')).toBeUndefined()
    })
  })

  describe('public methods', () => {
    it('reset() clears session for chatId', () => {
      const store = new MemorySessionStore()
      store.set('chat-1', {
        chatId: 'chat-1', agentName: 'c', agentSessionId: 's',
        totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0,
        lastActiveTime: 0, createdAt: 0,
      })
      const router = new RouterAgent({
        agents: { claude: makeMockAgent('claude') },
        defaultAgent: 'claude',
        sessionStore: store,
      })
      router.reset('chat-1')
      expect(store.get('chat-1')).toBeUndefined()
    })

    it('stop() is a no-op when no controller is registered', () => {
      const router = new RouterAgent({
        agents: { claude: makeMockAgent('claude') },
        defaultAgent: 'claude',
        sessionStore: new MemorySessionStore(),
      })
      expect(() => router.stop('key-1')).not.toThrow()
    })

    it('status() returns no-session text', () => {
      const router = new RouterAgent({
        agents: { claude: makeMockAgent('claude') },
        defaultAgent: 'claude',
        sessionStore: new MemorySessionStore(),
      })
      expect(router.status('nonexistent')).toContain('无活跃会话')
    })

    it('status() returns session info', () => {
      const store = new MemorySessionStore()
      store.set('chat-1', {
        chatId: 'chat-1',
        agentName: 'claude',
        agentSessionId: 'abc12345xxx',
        totalInputTokens: 1000,
        totalOutputTokens: 500,
        totalCostUsd: 0.05,
        lastActiveTime: Date.now(),
        createdAt: Date.now(),
      })
      const router = new RouterAgent({
        agents: { claude: makeMockAgent('claude') },
        defaultAgent: 'claude',
        sessionStore: store,
      })
      const status = router.status('chat-1')
      expect(status).toContain('claude')
      expect(status).toContain('abc12345')
      expect(status).toContain('1,000')
      expect(status).toContain('$0.0500')
    })
  })

  describe('dispose', () => {
    it('dispose calls sessionStore.dispose', async () => {
      const store = new MemorySessionStore()
      const disposeSpy = vi.spyOn(store, 'dispose')
      const router = new RouterAgent({
        agents: { claude: makeMockAgent('claude') },
        defaultAgent: 'claude',
        sessionStore: store,
      })
      await router.dispose()
      expect(disposeSpy).toHaveBeenCalled()
    })
  })

  describe('handle — agent switch token accounting', () => {
    it('resets token/cost when switching to a different agent', async () => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))

        const claudeAgent = makeMockAgent('claude', [
          { type: 'session', sessionId: 'claude-sess-1' },
          { type: 'text', text: 'hi from claude' },
          { type: 'done', costUsd: 0.05, usage: { inputTokens: 100, outputTokens: 50 } },
        ])
        const store = new MemorySessionStore()
        const router1 = new RouterAgent({
          agents: { claude: claudeAgent, codex: makeMockAgent('codex') },
          defaultAgent: 'claude',
          sessionStore: store,
        })
        await router1.handle(makeMsgCtx({ text: 'first' }))
        const afterClaude = store.get('chat-1')!
        expect(afterClaude.agentName).toBe('claude')
        expect(afterClaude.totalInputTokens).toBe(100)
        expect(afterClaude.totalOutputTokens).toBe(50)
        expect(afterClaude.totalCostUsd).toBeCloseTo(0.05)
        const claudeCreatedAt = afterClaude.createdAt

        // Move clock forward by 1 hour
        vi.setSystemTime(new Date('2026-01-01T01:00:00Z'))

        const codexAgent = makeMockAgent('codex', [
          { type: 'session', sessionId: 'codex-sess-1' },
          { type: 'text', text: 'hi from codex' },
          { type: 'done', costUsd: 0.02, usage: { inputTokens: 30, outputTokens: 20 } },
        ])
        const router2 = new RouterAgent({
          agents: { claude: claudeAgent, codex: codexAgent },
          defaultAgent: 'claude',
          route: () => 'codex',
          sessionStore: store,
        })
        await router2.handle(makeMsgCtx({ text: 'second' }))
        const afterCodex = store.get('chat-1')!
        expect(afterCodex.agentName).toBe('codex')
        expect(afterCodex.agentSessionId).toBe('codex-sess-1')
        expect(afterCodex.totalInputTokens).toBe(30)
        expect(afterCodex.totalOutputTokens).toBe(20)
        expect(afterCodex.totalCostUsd).toBeCloseTo(0.02)
        // createdAt MUST be refreshed on agent switch (not inherited from claude session)
        expect(afterCodex.createdAt).toBeGreaterThan(claudeCreatedAt)
        expect(afterCodex.createdAt).toBe(new Date('2026-01-01T01:00:00Z').getTime())
      } finally {
        vi.useRealTimers()
      }
    })

    it('accumulates token/cost when continuing with the same agent', async () => {
      const store = new MemorySessionStore()

      const router1 = new RouterAgent({
        agents: { claude: makeMockAgent('claude', [
          { type: 'session', sessionId: 'claude-sess-1' },
          { type: 'text', text: 't1' },
          { type: 'done', costUsd: 0.05, usage: { inputTokens: 100, outputTokens: 50 } },
        ]) },
        defaultAgent: 'claude',
        sessionStore: store,
      })
      await router1.handle(makeMsgCtx({ text: 'first' }))

      const router2 = new RouterAgent({
        agents: { claude: makeMockAgent('claude', [
          { type: 'session', sessionId: 'claude-sess-2' },
          { type: 'text', text: 't2' },
          { type: 'done', costUsd: 0.05, usage: { inputTokens: 100, outputTokens: 50 } },
        ]) },
        defaultAgent: 'claude',
        sessionStore: store,
      })
      await router2.handle(makeMsgCtx({ text: 'second' }))

      const session = store.get('chat-1')!
      expect(session.agentName).toBe('claude')
      expect(session.totalInputTokens).toBe(200) // 100 + 100
      expect(session.totalOutputTokens).toBe(100) // 50 + 50
      expect(session.totalCostUsd).toBeCloseTo(0.10) // 0.05 + 0.05
    })
  })

  describe('handle — concurrent conversation isolation', () => {
    it('stop(conversationKey) aborts only the matching conversation', async () => {
      let abortedA = false
      let abortedB = false

      const makeGatedAgent = (name: string, onAbort: () => void): Agent => ({
        name,
        query: (_prompt: string, opts: AgentOptions) => ({
          async *[Symbol.asyncIterator]() {
            const ctrl = opts.abortController!
            ctrl.signal.addEventListener('abort', onAbort)
            await new Promise<void>((resolve) => {
              ctrl.signal.addEventListener('abort', () => resolve())
            })
            yield { type: 'error', message: 'aborted' } as AgentMessage
          },
        }),
      })

      const router = new RouterAgent({
        agents: {
          a: makeGatedAgent('a', () => { abortedA = true }),
          b: makeGatedAgent('b', () => { abortedB = true }),
        },
        defaultAgent: 'a',
        route: (ctx) => ctx.userId === 'B' ? 'b' : 'a',
        sessionStore: new MemorySessionStore(),
      })

      const ctxA = makeMsgCtx({ chatId: 'g1', userId: 'A', conversationKey: 'g1|A', text: 'a' })
      const ctxB = makeMsgCtx({ chatId: 'g1', userId: 'B', conversationKey: 'g1|B', text: 'b' })

      const pA = router.handle(ctxA)
      const pB = router.handle(ctxB)

      // Allow both agents to register their listeners
      await new Promise((r) => setImmediate(r))

      router.stop('g1|A')

      // Allow the abort to propagate
      await new Promise((r) => setImmediate(r))
      expect(abortedA).toBe(true)
      expect(abortedB).toBe(false)

      router.stop('g1|B')
      await Promise.all([pA.catch(() => {}), pB.catch(() => {})])
      expect(abortedB).toBe(true)
    })

    it('A request finishing does not delete B\'s abort controller', async () => {
      let abortedB = false

      const finishImmediatelyAgent: Agent = {
        name: 'fast',
        query: (_prompt: string) => ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'text', text: 'done' } as AgentMessage
            yield { type: 'done' } as AgentMessage
          },
        }),
      }

      const stuckAgent: Agent = {
        name: 'stuck',
        query: (_prompt: string, opts: AgentOptions) => ({
          async *[Symbol.asyncIterator]() {
            const ctrl = opts.abortController!
            ctrl.signal.addEventListener('abort', () => { abortedB = true })
            await new Promise<void>((resolve) => {
              ctrl.signal.addEventListener('abort', () => resolve())
            })
            yield { type: 'error', message: 'aborted' } as AgentMessage
          },
        }),
      }

      const router = new RouterAgent({
        agents: { fast: finishImmediatelyAgent, stuck: stuckAgent },
        defaultAgent: 'fast',
        route: (ctx) => ctx.userId === 'B' ? 'stuck' : 'fast',
        sessionStore: new MemorySessionStore(),
      })

      const ctxA = makeMsgCtx({ chatId: 'g1', userId: 'A', conversationKey: 'g1|A', text: 'a' })
      const ctxB = makeMsgCtx({ chatId: 'g1', userId: 'B', conversationKey: 'g1|B', text: 'b' })

      const pB = router.handle(ctxB)
      await new Promise((r) => setImmediate(r))

      // A starts and finishes quickly
      await router.handle(ctxA)

      // B's controller should still be live — call /stop on B
      router.stop('g1|B')
      await pB.catch(() => {})
      expect(abortedB).toBe(true)
    })
  })
})
