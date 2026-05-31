import { describe, it, expect } from 'vitest'
import { createApp } from '../../src/core/app.js'
import type { ChannelAdapter, ChannelCallbacks, ChannelSenderFactory, IncomingMessage, IncomingEvent } from '../../src/channel/types.js'
import type { ReplyStream, ReplyStreamState } from '../../src/types.js'
import type { RuntimeEventContext } from '../../src/types.js'

class StubAdapter implements ChannelAdapter {
  readonly name = 'stub'
  private callbacks: ChannelCallbacks | null = null
  started = false
  stopped = false

  async start(cb: ChannelCallbacks): Promise<void> {
    this.callbacks = cb
    this.started = true
  }

  async stop(): Promise<void> {
    this.callbacks = null
    this.stopped = true
  }

  async injectMessage(partial: Partial<IncomingMessage> = {}): Promise<string[]> {
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
        }
      },
    }
    await this.callbacks!.onMessage({
      channelName: 'stub',
      chatId: 'c1',
      userId: 'u1',
      type: 'text',
      content: 'hi',
      traceId: 't1',
      raw: {},
      senderFactory: factory,
      ...partial,
    })
    return replies
  }
}

describe('createApp with ChannelAdapter', () => {
  it('accepts a custom adapter and routes messages to onMessage', async () => {
    const adapter = new StubAdapter()
    const seen: string[] = []
    const app = createApp({ adapter, singleInstance: false })
    app.onMessage(async (ctx) => { seen.push(ctx.text) })
    await app.start()
    await adapter.injectMessage({ content: 'hello world' })
    expect(seen).toEqual(['hello world'])
    await app.stop()
  })

  it('does not require botId/secret when adapter is provided', () => {
    const adapter = new StubAdapter()
    expect(() => createApp({ adapter, singleInstance: false })).not.toThrow()
  })

  it('adapter.start/stop are called by app.start/stop', async () => {
    const adapter = new StubAdapter()
    const app = createApp({ adapter, singleInstance: false })
    await app.start()
    expect(adapter.started).toBe(true)
    await app.stop()
    expect(adapter.stopped).toBe(true)
  })
})
