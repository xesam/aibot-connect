import { describe, it, expect, vi } from 'vitest'
import { Dispatcher } from '../../src/core/dispatcher.js'
import type { MessageContext } from '../../src/types.js'

function makeCtx(chatId = 'chat-1'): MessageContext {
  return {
    kind: 'message',
    command: undefined,
    text: 'hello',
    chatId,
    userId: 'user-1',
    conversationKey: `conv:${chatId}`,
    traceId: `trace-${chatId}`,
    channelName: 'stub',
    state: {},
    msgType: 'text',
    raw: {} as any,
    reply: vi.fn().mockResolvedValue(undefined),
    replyStream: vi.fn().mockReturnValue({
      append: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockReturnValue('idle'),
    }),
  }
}

describe('Dispatcher', () => {
  it('calls handler for new message', async () => {
    const dispatcher = new Dispatcher({ onBusy: 'drop' })
    const handler = vi.fn().mockResolvedValue(undefined)
    const ctx = makeCtx()

    await dispatcher.dispatch(ctx, handler)
    expect(handler).toHaveBeenCalledWith(ctx)
  })

  it('drops second message when first is processing (onBusy: drop)', async () => {
    const dispatcher = new Dispatcher({ onBusy: 'drop' })
    let resolveFirst!: () => void
    const firstHandler = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => { resolveFirst = resolve })
    )
    const secondHandler = vi.fn().mockResolvedValue(undefined)
    const ctx = makeCtx()

    const firstDone = dispatcher.dispatch(ctx, firstHandler)
    await dispatcher.dispatch(ctx, secondHandler)

    expect(secondHandler).not.toHaveBeenCalled()
    resolveFirst()
    await firstDone
  })

  it('calls onBusy function when busy', async () => {
    const onBusy = vi.fn().mockResolvedValue(undefined)
    const dispatcher = new Dispatcher({ onBusy })
    let resolveFirst!: () => void
    const firstHandler = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => { resolveFirst = resolve })
    )
    const ctx = makeCtx()

    const firstDone = dispatcher.dispatch(ctx, firstHandler)
    await dispatcher.dispatch(ctx, vi.fn())

    expect(onBusy).toHaveBeenCalledWith(ctx)
    resolveFirst()
    await firstDone
  })

  it('releases lock after handler throws', async () => {
    const dispatcher = new Dispatcher({ onBusy: 'drop' })
    const failingHandler = vi.fn().mockRejectedValue(new Error('boom'))
    const ctx = makeCtx()

    await dispatcher.dispatch(ctx, failingHandler)

    const secondHandler = vi.fn().mockResolvedValue(undefined)
    await dispatcher.dispatch(ctx, secondHandler)
    expect(secondHandler).toHaveBeenCalled()
  })

  it('skips fallback error when stream is already finished', async () => {
    const dispatcher = new Dispatcher({ onBusy: 'drop' })
    const stream = {
      append: vi.fn(),
      end: vi.fn().mockResolvedValue(undefined),
      error: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockReturnValue('ended'),
    }
    const ctx = makeCtx()
    ctx.replyStream = vi.fn().mockReturnValue(stream)
    const failingHandler = vi.fn().mockRejectedValue(new Error('boom'))

    await dispatcher.dispatch(ctx, failingHandler)

    expect(stream.error).not.toHaveBeenCalled()
  })

  it('different chatIds are processed concurrently', async () => {
    const dispatcher = new Dispatcher({ onBusy: 'drop' })
    const order: string[] = []
    let resolveA!: () => void
    const handlerA = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => {
        resolveA = resolve
        order.push('A start')
      })
    )
    const handlerB = vi.fn().mockImplementation(async () => { order.push('B start') })

    const ctxA = makeCtx('chat-A')
    const ctxB = makeCtx('chat-B')

    const doneA = dispatcher.dispatch(ctxA, handlerA)
    await dispatcher.dispatch(ctxB, handlerB)

    expect(order).toContain('B start')
    resolveA()
    await doneA
  })

  it('allows same conversation in parallel mode', async () => {
    const dispatcher = new Dispatcher({ onBusy: 'drop', dispatchMode: 'parallel' })
    let resolveFirst!: () => void
    const firstHandler = vi.fn().mockReturnValue(
      new Promise<void>((resolve) => { resolveFirst = resolve })
    )
    const secondHandler = vi.fn().mockResolvedValue(undefined)
    const ctx = makeCtx('chat-1')

    const firstDone = dispatcher.dispatch(ctx, firstHandler)
    await dispatcher.dispatch(ctx, secondHandler)

    expect(secondHandler).toHaveBeenCalledTimes(1)
    resolveFirst()
    await firstDone
  })
})
