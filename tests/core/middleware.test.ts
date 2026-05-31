import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChannelAdapter, ChannelCallbacks, ChannelSenderFactory, IncomingMessage, IncomingEvent } from '../../src/channel/types.js'
import type { ReplyStream, ReplyStreamState, RuntimeEventContext } from '../../src/types.js'

function makeIncomingMessage(overrides: Partial<IncomingMessage> = {}): { msg: IncomingMessage; replies: string[]; streamCalls: string[] } {
  const replies: string[] = []
  const streamCalls: string[] = []
  const factory: ChannelSenderFactory = {
    makeSender(_rc: RuntimeEventContext) {
      return {
        async reply(text: string) { replies.push(text) },
        replyStream(): ReplyStream {
          return {
            append(text: string) { streamCalls.push(`append:${text}`) },
            async end() { streamCalls.push('end') },
            async error(message: string) { streamCalls.push(`error:${message}`) },
            getState(): ReplyStreamState { return 'idle' },
          }
        },
        getState(): ReplyStreamState { return 'idle' },
      }
    },
  }
  const msg: IncomingMessage = {
    channelName: 'stub',
    chatId: 'chat-1',
    userId: 'user-1',
    type: 'text',
    content: 'hello',
    traceId: 'req-1',
    raw: { headers: { req_id: 'req-1' }, body: {} },
    senderFactory: factory,
    ...overrides,
  }
  return { msg, replies, streamCalls }
}

function makeIncomingEvent(overrides: Partial<IncomingEvent> = {}): { evt: IncomingEvent; replies: string[] } {
  const replies: string[] = []
  const factory: ChannelSenderFactory = {
    makeSender(_rc: RuntimeEventContext) {
      return {
        async reply(text: string) { replies.push(text) },
        replyStream(): ReplyStream {
          return {
            append() {},
            async end() {},
            async error() {},
            getState(): ReplyStreamState { return 'idle' },
          }
        },
        getState(): ReplyStreamState { return 'idle' },
      }
    },
  }
  const evt: IncomingEvent = {
    channelName: 'stub',
    eventType: 'enter_chat',
    chatId: 'chat-1',
    userId: 'user-1',
    traceId: 'req-1',
    raw: { headers: { req_id: 'req-1' }, body: {} },
    senderFactory: factory,
    ...overrides,
  }
  return { evt, replies }
}

class StubAdapter implements ChannelAdapter {
  readonly name = 'stub'
  private callbacks: ChannelCallbacks | null = null

  async start(cb: ChannelCallbacks): Promise<void> {
    this.callbacks = cb
  }

  async stop(): Promise<void> {
    this.callbacks = null
  }

  async injectMessage(msg: IncomingMessage): Promise<void> {
    await this.callbacks!.onMessage(msg)
  }

  async injectEvent(evt: IncomingEvent): Promise<void> {
    await this.callbacks!.onEvent(evt)
  }
}

describe('createApp phase 2 middleware', () => {
  let adapter: StubAdapter

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    adapter = new StubAdapter()
  })

  it('provides structured ctx.command to command handlers', async () => {
    const { createApp } = await import('../../src/core/app.js')
    const handler = vi.fn().mockResolvedValue(undefined)
    const app = createApp({ adapter, singleInstance: false })

    app.onCommand('reset', handler)
    await app.start()

    const { msg } = makeIncomingMessage({ content: '/reset force now', traceId: 'req-1' })
    await adapter.injectMessage(msg)

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].command).toEqual({
      name: 'reset',
      args: 'force now',
      raw: '/reset force now',
    })
    expect(handler.mock.calls[0][0].traceId).toBe('req-1')

    await app.stop()
  })

  it('runs middleware around message handlers in registration order', async () => {
    const { createApp } = await import('../../src/core/app.js')
    const order: string[] = []
    const app = createApp({ adapter, singleInstance: false })

    app.use(async (_ctx, next) => {
      order.push('mw1-before')
      await next()
      order.push('mw1-after')
    })

    app.use(async (ctx, next) => {
      order.push(`mw2-${ctx.command ? 'command' : 'message'}-before`)
      await next()
      order.push('mw2-after')
    })

    app.onMessage(async (ctx) => {
      if (ctx.kind === 'event') return
      expect(ctx.command).toBeUndefined()
      order.push('handler')
    })

    await app.start()
    const { msg } = makeIncomingMessage({ content: 'hello' })
    await adapter.injectMessage(msg)

    expect(order).toEqual([
      'mw1-before',
      'mw2-message-before',
      'handler',
      'mw2-after',
      'mw1-after',
    ])

    await app.stop()
  })

  it('runs middleware around command handlers and preserves ctx.command', async () => {
    const { createApp } = await import('../../src/core/app.js')
    const order: string[] = []
    const app = createApp({ adapter, singleInstance: false })

    app.use(async (ctx, next) => {
      order.push(`mw-before:${ctx.command?.name ?? 'none'}`)
      await next()
      order.push(`mw-after:${ctx.command?.name ?? 'none'}`)
    })

    app.onCommand('reset', async (ctx) => {
      order.push(`handler:${ctx.command?.args ?? ''}`)
    })

    await app.start()
    const { msg } = makeIncomingMessage({ content: '/reset now' })
    await adapter.injectMessage(msg)

    expect(order).toEqual([
      'mw-before:reset',
      'handler:now',
      'mw-after:reset',
    ])

    await app.stop()
  })

  it('runs middleware around enter_chat handlers and marks event kind', async () => {
    const { createApp } = await import('../../src/core/app.js')
    const order: string[] = []
    const app = createApp({ adapter, singleInstance: false })

    app.use(async (ctx, next) => {
      order.push(`mw-before:${ctx.kind}`)
      await next()
      order.push(`mw-after:${ctx.kind}`)
    })

    app.onEvent(async (ctx) => {
      order.push(`handler:${ctx.kind}`)
    })

    await app.start()
    const { evt } = makeIncomingEvent({ traceId: 'req-2' })
    await adapter.injectEvent(evt)

    expect(order).toEqual([
      'mw-before:event',
      'handler:event',
      'mw-after:event',
    ])

    await app.stop()
  })

  it('emits event.received and exposes traceId on enter_chat handlers', async () => {
    const { createApp } = await import('../../src/core/app.js')
    const events: any[] = []
    const traces: string[] = []
    const app = createApp({
      adapter,
      singleInstance: false,
      onRuntimeEvent: (event) => {
        events.push(event)
      },
    })

    app.onEvent(async (ctx) => {
      traces.push(ctx.traceId)
      await ctx.reply('welcome')
    })

    await app.start()
    const { evt } = makeIncomingEvent({ traceId: 'req-enter', chatId: 'chat-1', userId: 'user-1' })
    await adapter.injectEvent(evt)

    expect(traces).toEqual(['req-enter'])
    expect(events.map((event) => event.event)).toEqual([
      'event.received',
      'handler.started',
      'handler.completed',
    ])

    await app.stop()
  })

  it('shares ctx.state across command, message, and enter_chat for the same chatId', async () => {
    const { createApp } = await import('../../src/core/app.js')
    const snapshots: Array<Record<string, unknown>> = []
    const app = createApp({ adapter, singleInstance: false })

    app.onCommand('reset', async (ctx) => {
      ctx.state.count = 1
      snapshots.push({ ...ctx.state })
    })

    app.onMessage(async (ctx) => {
      ctx.state.count = Number(ctx.state.count ?? 0) + 1
      snapshots.push({ ...ctx.state })
    })

    app.onEvent(async (ctx) => {
      ctx.state.seen = true
      snapshots.push({ ...ctx.state })
    })

    await app.start()

    const { msg: m1 } = makeIncomingMessage({ content: '/reset', chatId: 'chat-1', userId: 'user-1', traceId: 'req-1' })
    await adapter.injectMessage(m1)
    const { msg: m2 } = makeIncomingMessage({ content: 'hello', chatId: 'chat-1', userId: 'user-1', traceId: 'req-2' })
    await adapter.injectMessage(m2)
    const { evt } = makeIncomingEvent({ chatId: 'chat-1', userId: 'user-1', traceId: 'req-3' })
    await adapter.injectEvent(evt)

    expect(snapshots).toEqual([
      { count: 1 },
      { count: 2 },
      { count: 2, seen: true },
    ])

    await app.stop()
  })

  it('calls onError before framework fallback for message handlers', async () => {
    const { createApp } = await import('../../src/core/app.js')
    const onErrorHook = vi.fn(async (ctx, error) => {
      await ctx.reply(`hook:${(error as Error).message}`)
    })
    const app = createApp({
      adapter,
      singleInstance: false,
      onError: onErrorHook,
    })

    app.onMessage(async (ctx) => {
      if (ctx.kind === 'event') return
      throw new Error('boom')
    })

    await app.start()

    const { msg, replies } = makeIncomingMessage()
    await adapter.injectMessage(msg)

    expect(onErrorHook).toHaveBeenCalledTimes(1)
    expect(replies).toEqual(['hook:boom'])

    await app.stop()
  })

  it('calls onTimeout when a handler exceeds handlerTimeoutMs', async () => {
    const { createApp } = await import('../../src/core/app.js')
    const timeoutHook = vi.fn(async (ctx) => {
      await ctx.reply('timeout')
    })
    const app = createApp({
      adapter,
      singleInstance: false,
      handlerTimeoutMs: 10,
      onTimeout: timeoutHook,
    })

    app.onMessage(async (ctx) => {
      if (ctx.kind === 'event') return
      await new Promise((resolve) => setTimeout(resolve, 30))
    })

    await app.start()

    const { msg, replies } = makeIncomingMessage()
    await adapter.injectMessage(msg)

    expect(timeoutHook).toHaveBeenCalledTimes(1)
    expect(replies).toEqual(['timeout'])

    await app.stop()
  })

  it('falls back safely when onError throws', async () => {
    const { createApp } = await import('../../src/core/app.js')
    const onErrorHook = vi.fn(async () => {
      throw new Error('hook failed')
    })
    const app = createApp({
      adapter,
      singleInstance: false,
      onError: onErrorHook,
    })

    app.onMessage(async (ctx) => {
      if (ctx.kind === 'event') return
      throw new Error('boom')
    })

    await app.start()

    const { msg, streamCalls } = makeIncomingMessage()
    await adapter.injectMessage(msg)

    expect(onErrorHook).toHaveBeenCalledTimes(1)
    expect(streamCalls).toEqual(['error:处理出错：boom'])

    await app.stop()
  })

  it('calls onTimeout for enter_chat and uses event reply path', async () => {
    const { createApp } = await import('../../src/core/app.js')
    const timeoutHook = vi.fn(async (ctx) => {
      await ctx.reply('event-timeout')
    })
    const app = createApp({
      adapter,
      singleInstance: false,
      handlerTimeoutMs: 10,
      onTimeout: timeoutHook,
    })

    app.onEvent(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30))
    })

    await app.start()

    const replies: string[] = []
    const factory: ChannelSenderFactory = {
      makeSender(_rc: RuntimeEventContext) {
        // Track state to ignore duplicate reply calls (mirrors WecomResponseSender behaviour)
        let state: ReplyStreamState = 'idle'
        return {
          async reply(text: string) {
            if (state === 'ended') return
            replies.push(text)
            state = 'ended'
          },
          replyStream(): ReplyStream {
            return {
              append() {},
              async end() {},
              async error() {},
              getState(): ReplyStreamState { return state },
            }
          },
          getState(): ReplyStreamState { return state },
        }
      },
    }
    const { evt } = makeIncomingEvent({ traceId: 'req-4', senderFactory: factory })
    await adapter.injectEvent(evt)

    expect(timeoutHook).toHaveBeenCalledTimes(1)
    expect(replies).toEqual(['event-timeout'])

    await app.stop()
  })

  it('emits runtime events and exposes matching traceId on message handlers', async () => {
    const { createApp } = await import('../../src/core/app.js')
    const events: any[] = []
    const traces: string[] = []
    const app = createApp({
      adapter,
      singleInstance: false,
      onRuntimeEvent: (event) => {
        events.push(event)
      },
    })

    app.onMessage(async (ctx) => {
      if (ctx.kind === 'event') return
      traces.push(ctx.traceId)
      await ctx.reply('ok')
    })

    await app.start()
    const { msg } = makeIncomingMessage({ content: 'hello', traceId: 'req-1', chatId: 'chat-1', userId: 'user-1' })
    await adapter.injectMessage(msg)

    expect(traces).toEqual(['req-1'])
    expect(events.map((event) => event.event)).toEqual([
      'message.received',
      'handler.started',
      'handler.completed',
    ])
    expect(events[0]).toMatchObject({
      traceId: 'req-1',
      chatId: 'chat-1',
      userId: 'user-1',
      kind: 'message',
    })

    await app.stop()
  })

  it('emits command runtime events with commandName', async () => {
    const { createApp } = await import('../../src/core/app.js')
    const events: any[] = []
    const app = createApp({
      adapter,
      singleInstance: false,
      onRuntimeEvent: (event) => {
        events.push(event)
      },
    })

    app.onCommand('reset', async (ctx) => {
      await ctx.reply(`command:${ctx.traceId}`)
    })

    await app.start()
    const { msg } = makeIncomingMessage({ content: '/reset now', traceId: 'req-1' })
    await adapter.injectMessage(msg)

    expect(events[0]).toMatchObject({
      event: 'message.received',
      kind: 'command',
      commandName: 'reset',
      traceId: 'req-1',
    })

    await app.stop()
  })

  it('emits busy.rejected when a second message hits the same chatId', async () => {
    const { createApp } = await import('../../src/core/app.js')
    const events: any[] = []
    let resolveFirst!: () => void
    const app = createApp({
      adapter,
      singleInstance: false,
      onRuntimeEvent: (event) => {
        events.push(event)
      },
      onBusy: 'drop',
    })

    app.onMessage(async (ctx) => {
      if (ctx.kind === 'event') return
      await new Promise<void>((resolve) => {
        resolveFirst = resolve
      })
    })

    await app.start()

    const { msg: msgA } = makeIncomingMessage({ content: 'first', traceId: 'req-1', chatId: 'chat-1', userId: 'user-1' })
    const { msg: msgB } = makeIncomingMessage({ content: 'second', traceId: 'req-2', chatId: 'chat-1', userId: 'user-1' })

    const firstRun = adapter.injectMessage(msgA)
    await adapter.injectMessage(msgB)
    resolveFirst()
    await firstRun

    expect(events.some((event) => event.event === 'busy.rejected' && event.traceId === 'req-2')).toBe(true)

    await app.stop()
  })

  it('emits timeout runtime events before timeout fallback', async () => {
    const { createApp } = await import('../../src/core/app.js')
    const events: any[] = []
    const app = createApp({
      adapter,
      singleInstance: false,
      handlerTimeoutMs: 10,
      onRuntimeEvent: (event) => {
        events.push(event)
      },
      onTimeout: async (ctx) => {
        await ctx.reply('timeout')
      },
    })

    app.onMessage(async (ctx) => {
      if (ctx.kind === 'event') return
      await new Promise((resolve) => setTimeout(resolve, 30))
    })

    await app.start()
    const { msg } = makeIncomingMessage({ content: 'hello', traceId: 'req-1' })
    await adapter.injectMessage(msg)

    const timeoutEvent = events.find((event) => event.event === 'handler.timed_out')
    expect(timeoutEvent).toMatchObject({
      traceId: 'req-1',
      kind: 'message',
      errorMessage: 'Handler timed out after 10ms',
    })
    expect(timeoutEvent.durationMs).toBeGreaterThanOrEqual(0)

    await app.stop()
  })

  it('processes same chat with different users concurrently by default', async () => {
    const { createApp } = await import('../../src/core/app.js')
    let resolveFirst!: () => void
    const secondHandled = vi.fn()
    const app = createApp({
      adapter,
      singleInstance: false,
      onBusy: 'drop',
    })

    app.onMessage(async (ctx) => {
      if (ctx.kind === 'event') return
      if (ctx.userId === 'user-1') {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve
        })
        return
      }
      secondHandled()
    })

    await app.start()

    const { msg: m1 } = makeIncomingMessage({ content: 'first', chatId: 'group-1', userId: 'user-1', traceId: 'req-1' })
    const { msg: m2 } = makeIncomingMessage({ content: 'second', chatId: 'group-1', userId: 'user-2', traceId: 'req-2' })

    const first = adapter.injectMessage(m1)
    await adapter.injectMessage(m2)

    expect(secondHandled).toHaveBeenCalledTimes(1)
    resolveFirst()
    await first

    await app.stop()
  })

  it('handles multiple normal messages through a single onMessage handler', async () => {
    const { createApp } = await import('../../src/core/app.js')
    const handler = vi.fn(async (ctx) => {
      if (ctx.kind === 'event') return
      await ctx.reply(`echo:${ctx.text}`)
    })
    const app = createApp({
      adapter,
      singleInstance: false,
    })
    app.onMessage(handler)

    await app.start()
    const { msg: m1 } = makeIncomingMessage({ content: 'hello', traceId: 'req-1' })
    await adapter.injectMessage(m1)
    const { msg: m2 } = makeIncomingMessage({ content: 'world', traceId: 'req-2' })
    await adapter.injectMessage(m2)

    expect(handler).toHaveBeenCalledTimes(2)

    await app.stop()
  })
})
