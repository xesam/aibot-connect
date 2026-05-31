import type { ReplyStream } from '../types.js'
import type { RuntimeEventContext } from '../types.js'

export interface ChannelSender {
  reply(text: string): Promise<void>
  replyStream(): ReplyStream
}

export interface ChannelSenderFactory {
  makeSender(runtimeContext: RuntimeEventContext): ChannelSender
}

export interface IncomingMessage {
  channelName: string
  chatId: string
  userId: string
  type: 'text' | 'image' | 'file' | 'voice' | 'unsupported'
  content: string
  fileBuffer?: Buffer
  fileName?: string
  messageId?: string
  traceId: string
  raw: unknown
  senderFactory: ChannelSenderFactory
}

export interface IncomingEvent {
  channelName: string
  eventType: 'enter_chat'
  chatId: string
  userId: string
  messageId?: string
  traceId: string
  raw: unknown
  senderFactory: ChannelSenderFactory
}

export interface ChannelCallbacks {
  onMessage: (msg: IncomingMessage) => Promise<void>
  onEvent: (evt: IncomingEvent) => Promise<void>
}

export interface ChannelAdapter {
  readonly name: string
  start(callbacks: ChannelCallbacks): Promise<void>
  stop(): Promise<void>
}
