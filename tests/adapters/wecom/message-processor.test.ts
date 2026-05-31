import { describe, it, expect, vi } from 'vitest'
import { WecomMessageProcessor } from '../../../src/adapters/wecom/message-processor.js'

function makeWsMock() {
  return {
    downloadFile: vi.fn().mockResolvedValue({ buffer: Buffer.from('data'), filename: 'test.txt' }),
  }
}

function makeFrame(msgtype: string, extra: Record<string, unknown> = {}) {
  return {
    headers: { req_id: 'req-1' },
    body: {
      msgid: 'msg-1',
      aibotid: 'bot-1',
      chattype: 'single' as const,
      from: { userid: 'user-1' },
      msgtype,
      ...extra,
    },
  }
}

describe('WecomMessageProcessor', () => {
  it('processes text message', async () => {
    const ws = makeWsMock()
    const processor = new WecomMessageProcessor(ws as any)
    const frame = makeFrame('text', { text: { content: 'hello' } })
    const result = await processor.process(frame as any)
    expect(result.type).toBe('text')
    expect(result.content).toBe('hello')
    expect(result.chatId).toBe('user-1')
    expect(result.userId).toBe('user-1')
  })

  it('uses chatid for group messages', async () => {
    const ws = makeWsMock()
    const processor = new WecomMessageProcessor(ws as any)
    const frame = makeFrame('text', {
      text: { content: 'hi' },
      chattype: 'group',
      chatid: 'group-123',
    })
    const result = await processor.process(frame as any)
    expect(result.chatId).toBe('group-123')
  })

  it('processes voice as text using transcription', async () => {
    const ws = makeWsMock()
    const processor = new WecomMessageProcessor(ws as any)
    const frame = makeFrame('voice', { voice: { content: 'transcribed text' } })
    const result = await processor.process(frame as any)
    expect(result.type).toBe('voice')
    expect(result.content).toBe('transcribed text')
  })

  it('marks unsupported types', async () => {
    const ws = makeWsMock()
    const processor = new WecomMessageProcessor(ws as any)
    const frame = makeFrame('video')
    const result = await processor.process(frame as any)
    expect(result.type).toBe('unsupported')
  })

  it('downloads file for file messages', async () => {
    const ws = makeWsMock()
    const processor = new WecomMessageProcessor(ws as any)
    const frame = makeFrame('file', {
      file: { url: 'https://example.com/file', aeskey: 'key' },
    })
    const result = await processor.process(frame as any)
    expect(result.type).toBe('file')
    expect(result.fileBuffer).toBeDefined()
    expect(result.fileName).toBe('test.txt')
  })
})
