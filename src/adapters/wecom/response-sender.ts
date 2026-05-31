import type { WSClient, WsFrameHeaders } from '@wecom/aibot-node-sdk'
import { generateReqId } from '@wecom/aibot-node-sdk'
import { log, type Logger } from '../../logger.js'
import type { ReplyStream, ReplyStreamState, RuntimeEvent } from '../../types.js'
import type { RuntimeEventContext, RuntimeEventExtras } from '../../core/runtime-events.js'
import { isTerminalState, toErrorMessage } from '../../utils.js'

type ResponseSenderEvent =
  | 'stream.started'
  | 'stream.updated'
  | 'stream.ended'
  | 'stream.failed'
  | 'reply.sent'

type ResponseSenderEventExtras<T extends ResponseSenderEvent> =
  Omit<RuntimeEventExtras<T>, 'streamId'>

const MAX_STREAM_BYTES = 19000

export class WecomResponseSender {
  private ws: WSClient
  private frame: WsFrameHeaders
  private streamId: string
  private buffer = ''
  private state: ReplyStreamState = 'idle'
  private readonly runtimeContext: RuntimeEventContext
  private readonly emitRuntimeEvent?: (event: RuntimeEvent) => void
  private readonly logger: Logger

  constructor(
    ws: WSClient,
    frame: WsFrameHeaders,
    runtimeContext: RuntimeEventContext,
    emitRuntimeEvent?: (event: RuntimeEvent) => void,
    logger?: Logger,
  ) {
    this.ws = ws
    this.frame = frame
    this.streamId = generateReqId('stream')
    this.runtimeContext = runtimeContext
    this.emitRuntimeEvent = emitRuntimeEvent
    this.logger = logger ?? log
  }

  append(text: string): void {
    if (isTerminalState(this.state)) {
      this.logger.debug(`[ResponseSender] Ignoring append after terminal state: ${this.state}`)
      return
    }
    if (this.state === 'idle') {
      this.state = 'streaming'
      this.emit('stream.started')
    }
    this.buffer += text
    this.emit('stream.updated')
    if (Buffer.byteLength(this.buffer, 'utf-8') > MAX_STREAM_BYTES) {
      this.flushChunk(false).catch((error) => {
        this.markFailed(error)
      })
    } else {
      this.ws.replyStreamNonBlocking(
        this.frame,
        this.streamId,
        this.buffer,
        false,
      ).catch((error) => {
        this.markFailed(error)
      })
    }
  }

  async sendFinal(): Promise<void> {
    if (isTerminalState(this.state)) {
      this.logger.debug(`[ResponseSender] Ignoring end after terminal state: ${this.state}`)
      return
    }
    if (this.buffer.length > 0) {
      this.logger.info(`[ResponseSender] Reply done (${this.buffer.length} chars)`)
      await this.flushChunk(true)
    } else {
      await this.ws.replyStream(this.frame, this.streamId, '', true)
    }
    if (isTerminalState(this.state)) return  // 防止 await 期间被 markFailed 翻转后再覆盖
    this.state = 'ended'
    this.emit('stream.ended')
  }

  async sendError(message: string): Promise<void> {
    if (isTerminalState(this.state)) {
      this.logger.debug(`[ResponseSender] Ignoring error after terminal state: ${this.state}`)
      return
    }
    this.buffer = ''
    this.logger.info(`[ResponseSender] Reply error: ${message}`)
    await this.ws.replyStream(
      this.frame,
      this.streamId,
      `[Error] ${message}`,
      true,
    )
    if (isTerminalState(this.state)) return  // 防止 await 期间被 markFailed 翻转后再覆盖
    this.state = 'failed'
    this.emit('stream.failed', {
      errorName: 'ReplyStreamError',
      errorMessage: message,
    })
  }

  async sendText(text: string): Promise<void> {
    if (this.state === 'streaming') {
      this.logger.debug('[ResponseSender] Ignoring reply() after stream has started')
      return
    }
    if (isTerminalState(this.state)) {
      this.logger.debug(`[ResponseSender] Ignoring reply() after terminal state: ${this.state}`)
      return
    }
    this.logger.info(`[ResponseSender] Reply text: ${text.slice(0, 200)}`)
    if (this.runtimeContext.kind === 'event') {
      await this.ws.replyWelcome(this.frame, {
        msgtype: 'text',
        text: { content: text },
      })
    } else {
      await this.ws.replyStream(this.frame, this.streamId, text, true)
    }
    this.state = 'ended'
    this.emit('reply.sent')
  }

  getState(): ReplyStreamState {
    return this.state
  }

  toReplyStream(): ReplyStream {
    return {
      append: (text: string) => this.append(text),
      end: () => this.sendFinal(),
      error: (message: string) => this.sendError(message),
      getState: () => this.getState(),
    }
  }

  private markFailed(error: unknown): void {
    if (this.state !== 'streaming') return
    this.state = 'failed'
    this.buffer = ''
    const message = toErrorMessage(error)
    this.logger.error(`[ResponseSender] Stream send failed: ${message}`)
    this.emit('stream.failed', {
      errorName: 'ReplyStreamError',
      errorMessage: message,
    })
  }

  private async flushChunk(finish: boolean): Promise<void> {
    if (this.buffer.length === 0) return
    await this.ws.replyStream(this.frame, this.streamId, this.buffer, finish)
    this.buffer = ''
    if (!finish) {
      this.streamId = generateReqId('stream')
    }
  }

  private emit<T extends ResponseSenderEvent>(
    event: T,
    extras: ResponseSenderEventExtras<T> = {} as ResponseSenderEventExtras<T>,
  ): void {
    if (!this.emitRuntimeEvent) return
    this.emitRuntimeEvent({
      event,
      traceId: this.runtimeContext.traceId,
      chatId: this.runtimeContext.chatId,
      userId: this.runtimeContext.userId,
      conversationKey: this.runtimeContext.conversationKey,
      kind: this.runtimeContext.kind,
      commandName: this.runtimeContext.commandName,
      messageId: this.runtimeContext.messageId,
      streamId: this.streamId,
      ...extras,
    } as Extract<RuntimeEvent, { event: T }>)
  }
}
