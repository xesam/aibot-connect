import type { ChannelSender } from '../channel/types.js'
import type {
  MessageContext,
  EventContext,
  ReplyStream,
  ProcessedMessage,
  CommandInfo,
} from '../types.js'

export function createMessageContext(
  processed: ProcessedMessage,
  sender: ChannelSender,
  state: Record<string, unknown>,
  conversationKey: string,
  traceId: string,
  channelName: string,
  command?: CommandInfo,
): MessageContext {
  return {
    get text() { return processed.content },
    get kind() { return command ? 'command' as const : 'message' as const },
    get command() { return command },
    get chatId() { return processed.chatId },
    get userId() { return processed.userId },
    get conversationKey() { return conversationKey },
    get traceId() { return traceId },
    get state() { return state },
    get channelName() { return channelName },
    get msgType() { return processed.type as MessageContext['msgType'] },
    get fileBuffer() { return processed.fileBuffer },
    get fileName() { return processed.fileName },
    get raw() { return processed.raw },
    reply(text: string): Promise<void> {
      return sender.reply(text)
    },
    replyStream(): ReplyStream {
      return sender.replyStream()
    },
  }
}

export function createEventContext(
  raw: unknown,
  chatId: string,
  userId: string,
  sender: ChannelSender,
  state: Record<string, unknown>,
  conversationKey: string,
  traceId: string,
  channelName: string,
): EventContext {
  return {
    get kind() { return 'event' as const },
    get command() { return undefined },
    get chatId() { return chatId },
    get userId() { return userId },
    get conversationKey() { return conversationKey },
    get traceId() { return traceId },
    get state() { return state },
    get channelName() { return channelName },
    get raw() { return raw },
    reply(text: string): Promise<void> {
      return sender.reply(text)
    },
  }
}
