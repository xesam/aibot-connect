import { beforeEach, describe, expect, it, vi } from 'vitest'

const onMock = vi.fn()
const connectMock = vi.fn()
const disconnectMock = vi.fn()
const expectedEvents = [
  'connected',
  'authenticated',
  'disconnected',
  'reconnecting',
  'error',
  'message.text',
  'message.image',
  'message.file',
  'message.voice',
  'event.enter_chat',
] as const

vi.mock('@wecom/aibot-node-sdk', () => {
  class WSClient {
    on = onMock
    connect = connectMock
    disconnect = disconnectMock
  }

  return {
    default: { WSClient },
  }
})

describe('WecomClient lifecycle', () => {
  beforeEach(() => {
    vi.resetModules()
    onMock.mockClear()
    connectMock.mockClear()
    disconnectMock.mockClear()
  })

  it('registers message and event listeners only once across repeated connect calls', async () => {
    const { WecomClient } = await import('../../../src/adapters/wecom/client.js')
    const client = new WecomClient(
      { botId: 'bot', secret: 'secret' },
      { onMessage: vi.fn(), onEvent: vi.fn() },
    )

    expect(onMock.mock.calls.map(([event]) => event)).toEqual(expectedEvents)

    client.connect()
    client.disconnect()
    client.connect()

    const registeredEvents = onMock.mock.calls.map(([event]) => event)

    expect(registeredEvents).toEqual(expectedEvents)
    expect(registeredEvents).toHaveLength(expectedEvents.length)
    expect(connectMock).toHaveBeenCalledTimes(2)
    expect(disconnectMock).toHaveBeenCalledTimes(1)
  })
})

describe('WecomClient readiness lifecycle', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('creates a fresh readiness wait cycle for a new connect attempt after a pre-ready failure', async () => {
    const handlers = new Map<string, Array<(...args: any[]) => void>>()
    const connectMock = vi.fn()

    class MockWSClient {
      connect(): void {
        connectMock()
      }

      disconnect(): void {}

      on(event: string, handler: (...args: any[]) => void): void {
        const existing = handlers.get(event) ?? []
        existing.push(handler)
        handlers.set(event, existing)
      }
    }

    vi.doMock('@wecom/aibot-node-sdk', () => ({
      default: { WSClient: MockWSClient },
    }))

    vi.doMock('../../../src/adapters/wecom/message-processor.js', () => ({
      WecomMessageProcessor: class MockWecomMessageProcessor {
        constructor(_ws: unknown) {}
      },
    }))

    vi.doMock('../../../src/logger.js', () => {
      const log = {
        info: vi.fn(),
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

    const { WecomClient } = await import('../../../src/adapters/wecom/client.js')
    const client = new WecomClient(
      { botId: 'bot-id', secret: 'secret' },
      {
        onMessage: vi.fn(),
        onEvent: vi.fn(),
      },
    )

    client.connect()
    const firstWait = client.waitUntilReady()
    handlers.get('error')?.forEach((handler) => handler(new Error('boom')))

    await expect(firstWait).rejects.toThrow('boom')
    expect(connectMock).toHaveBeenCalledTimes(1)

    client.connect()
    const secondWait = client.waitUntilReady()
    handlers.get('authenticated')?.forEach((handler) => handler())

    await expect(secondWait).resolves.toBeUndefined()
    expect(connectMock).toHaveBeenCalledTimes(2)
  })
})
