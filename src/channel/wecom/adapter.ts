import type { ChannelAdapter, ChannelCallbacks, ChannelSenderFactory } from '../types.js'
import { WecomClient } from '../../adapters/wecom/client.js'
import { WecomResponseSender } from '../../adapters/wecom/response-sender.js'
import { type Logger, log as defaultLog } from '../../logger.js'
import { createTraceId, getMessageId } from './utils.js'
import type { RuntimeEventContext } from '../../core/runtime-events.js'
import type { RuntimeEvent } from '../../types.js'
import type { WSClient, WsFrameHeaders } from '@wecom/aibot-node-sdk'

export interface WecomChannelAdapterOptions {
  botId: string
  secret: string
  logger?: Logger
  emitRuntimeEvent?: (event: RuntimeEvent) => void
}

export class WecomChannelAdapter implements ChannelAdapter {
  readonly name = 'wecom'
  private client: WecomClient | null = null
  private readonly logger: Logger

  constructor(private readonly options: WecomChannelAdapterOptions) {
    this.logger = options.logger ?? defaultLog
  }

  async start(callbacks: ChannelCallbacks): Promise<void> {
    const client = new WecomClient(
      { botId: this.options.botId, secret: this.options.secret, logger: this.logger },
      {
        onMessage: async (processed, frame) => {
          const traceId = createTraceId(frame)
          const messageId = getMessageId(frame)
          const ws = client.getWsClient()
          const senderFactory = this.makeSenderFactory(ws, frame)

          await callbacks.onMessage({
            channelName: 'wecom',
            chatId: processed.chatId,
            userId: processed.userId,
            type: processed.type,
            content: processed.content,
            fileBuffer: processed.fileBuffer,
            fileName: processed.fileName,
            messageId,
            traceId,
            raw: frame,
            senderFactory,
          })
        },
        onEvent: async (eventType, frame) => {
          if (eventType !== 'enter_chat') return

          const body = frame.body ?? {}
          const chatId = body.chatid ?? body.from?.userid ?? ''
          const userId = body.from?.userid ?? ''
          const traceId = createTraceId(frame)
          const messageId = getMessageId(frame)
          const ws = client.getWsClient()
          const senderFactory = this.makeSenderFactory(ws, frame)

          await callbacks.onEvent({
            channelName: 'wecom',
            eventType,
            chatId,
            userId,
            messageId,
            traceId,
            raw: frame,
            senderFactory,
          })
        },
      },
    )
    this.client = client
    client.connect()
    await client.waitUntilReady()
  }

  private makeSenderFactory(ws: WSClient, frame: WsFrameHeaders): ChannelSenderFactory {
    const emitRuntimeEvent = this.options.emitRuntimeEvent
    const logger = this.logger
    return {
      makeSender(rc: RuntimeEventContext) {
        const sender = new WecomResponseSender(ws, frame, rc, emitRuntimeEvent, logger)
        return {
          reply: (text) => sender.sendText(text),
          replyStream: () => sender.toReplyStream(),
        }
      },
    }
  }

  async stop(): Promise<void> {
    this.client?.disconnect()
    this.client = null
  }
}
