import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WecomResponseSender } from '../../../src/adapters/wecom/response-sender.js'

function makeFrame() {
  return { headers: { req_id: 'test-req-id' } }
}

function makeWsMock() {
  return {
    replyStream: vi.fn().mockResolvedValue({}),
    replyWelcome: vi.fn().mockResolvedValue({}),
    replyStreamNonBlocking: vi.fn().mockResolvedValue({}),
  }
}

describe('WecomResponseSender', () => {
  let ws: ReturnType<typeof makeWsMock>
  let frame: ReturnType<typeof makeFrame>

  function makeRuntimeContext() {
    return {
      traceId: 'trace-1',
      chatId: 'chat-1',
      userId: 'user-1',
      conversationKey: 'conv-1',
      kind: 'message' as const,
    }
  }

  beforeEach(() => {
    ws = makeWsMock()
    frame = makeFrame()
  })

  it('sendText calls replyStream with finish=true', async () => {
    const sender = new WecomResponseSender(ws as any, frame as any, makeRuntimeContext())
    await sender.sendText('hello')
    expect(ws.replyStream).toHaveBeenCalledWith(
      frame,
      expect.any(String),
      'hello',
      true,
    )
  })

  it('sendText on event kind calls replyWelcome', async () => {
    const sender = new WecomResponseSender(
      ws as any,
      frame as any,
      { ...makeRuntimeContext(), kind: 'event' },
    )
    await sender.sendText('welcome')
    expect(ws.replyWelcome).toHaveBeenCalledWith(frame, {
      msgtype: 'text',
      text: { content: 'welcome' },
    })
    expect(ws.replyStream).not.toHaveBeenCalledWith(
      frame,
      expect.any(String),
      'welcome',
      true,
    )
  })

  it('sendError resets buffer and sends error frame', async () => {
    const sender = new WecomResponseSender(ws as any, frame as any, makeRuntimeContext())
    sender.append('partial text')
    await sender.sendError('something went wrong')
    expect(ws.replyStream).toHaveBeenCalledWith(
      frame,
      expect.any(String),
      '[Error] something went wrong',
      true,
    )
  })

  it('sendFinal with empty buffer sends empty finish frame', async () => {
    const sender = new WecomResponseSender(ws as any, frame as any, makeRuntimeContext())
    await sender.sendFinal()
    expect(ws.replyStream).toHaveBeenCalledWith(
      frame,
      expect.any(String),
      '',
      true,
    )
  })

  it('append calls replyStreamNonBlocking', () => {
    const sender = new WecomResponseSender(ws as any, frame as any, makeRuntimeContext())
    sender.append('chunk')
    expect(ws.replyStreamNonBlocking).toHaveBeenCalled()
  })

  it('returned reply stream exposes state transitions', async () => {
    const sender = new WecomResponseSender(ws as any, frame as any, makeRuntimeContext())
    const stream = sender.toReplyStream()

    expect(stream.getState()).toBe('idle')

    stream.append('chunk')
    expect(stream.getState()).toBe('streaming')

    await stream.end()

    expect(stream.getState()).toBe('ended')
  })

  it('ignores append after terminal state', async () => {
    const sender = new WecomResponseSender(ws as any, frame as any, makeRuntimeContext())
    const stream = sender.toReplyStream()

    await stream.end()
    stream.append('late')

    expect(ws.replyStreamNonBlocking).not.toHaveBeenCalled()
  })

  it('ignores reply() after stream has started', async () => {
    const sender = new WecomResponseSender(ws as any, frame as any, makeRuntimeContext())

    sender.append('chunk')
    await sender.sendText('late text')

    expect(ws.replyStream).not.toHaveBeenCalledWith(
      frame,
      expect.any(String),
      'late text',
      true,
    )
  })

  it('marks stream as failed when non-blocking send rejects', async () => {
    const events: any[] = []
    const ws = {
      replyStreamNonBlocking: vi.fn().mockRejectedValue(new Error('network down')),
      replyStream: vi.fn().mockResolvedValue(undefined),
      replyWelcome: vi.fn().mockResolvedValue(undefined),
    }
    const sender = new WecomResponseSender(
      ws as any,
      { msgid: 'm1' } as any,
      { traceId: 't', chatId: 'c', userId: 'u', kind: 'message' } as any,
      (e) => events.push(e),
    )

    sender.append('hello')
    // wait for the rejected promise to settle
    await new Promise((r) => setImmediate(r))

    expect(sender.getState()).toBe('failed')
    expect(events.some(e => e.event === 'stream.failed')).toBe(true)
    expect(events.find(e => e.event === 'stream.failed')?.errorMessage).toContain('network down')
  })

  it('further append after async send failure is a no-op', async () => {
    const ws = {
      replyStreamNonBlocking: vi.fn().mockRejectedValue(new Error('boom')),
      replyStream: vi.fn().mockResolvedValue(undefined),
      replyWelcome: vi.fn().mockResolvedValue(undefined),
    }
    const sender = new WecomResponseSender(
      ws as any,
      { msgid: 'm1' } as any,
      { traceId: 't', chatId: 'c', userId: 'u', kind: 'message' } as any,
    )

    sender.append('first')
    await new Promise((r) => setImmediate(r))
    expect(sender.getState()).toBe('failed')

    sender.append('second')
    await new Promise((r) => setImmediate(r))

    // only the initial call was made; subsequent append was ignored
    expect(ws.replyStreamNonBlocking).toHaveBeenCalledTimes(1)
  })

  it('stream.failed is emitted at most once even if multiple sends reject', async () => {
    const events: any[] = []
    const ws = {
      replyStreamNonBlocking: vi.fn().mockRejectedValue(new Error('flaky')),
      replyStream: vi.fn().mockResolvedValue(undefined),
      replyWelcome: vi.fn().mockResolvedValue(undefined),
    }
    const sender = new WecomResponseSender(
      ws as any,
      { msgid: 'm1' } as any,
      { traceId: 't', chatId: 'c', userId: 'u', kind: 'message' } as any,
      (e) => events.push(e),
    )

    sender.append('a')
    sender.append('b')

    // drain both rejected promises' .catch microtasks
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    const failedEvents = events.filter(e => e.event === 'stream.failed')
    expect(failedEvents.length).toBe(1)
  })

  it('sendFinal does not overwrite failed state set by concurrent non-blocking reject', async () => {
    const events: any[] = []
    let resolveFlush: () => void = () => {}
    const flushPromise = new Promise<void>((r) => { resolveFlush = r })

    const ws = {
      replyStreamNonBlocking: vi.fn().mockRejectedValue(new Error('nb-fail')),
      // sendFinal awaits this; we hold it until the rejection has been processed
      replyStream: vi.fn().mockImplementation(() => flushPromise),
      replyWelcome: vi.fn().mockResolvedValue(undefined),
    }
    const sender = new WecomResponseSender(
      ws as any,
      { msgid: 'm1' } as any,
      { traceId: 't', chatId: 'c', userId: 'u', kind: 'message' } as any,
      (e) => events.push(e),
    )

    sender.append('hello')
    // start sendFinal — it will await replyStream (held by flushPromise)
    const finalPromise = sender.sendFinal()

    // let the rejected non-blocking promise settle first, flipping state to 'failed'
    await new Promise((r) => setImmediate(r))
    expect(sender.getState()).toBe('failed')

    // now let sendFinal's await resolve
    resolveFlush()
    await finalPromise

    // state must remain 'failed' — sendFinal must not overwrite it
    expect(sender.getState()).toBe('failed')
    expect(events.filter(e => e.event === 'stream.ended').length).toBe(0)
    expect(events.filter(e => e.event === 'stream.failed').length).toBe(1)
  })
})
