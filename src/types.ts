import type { ChannelAdapter } from './channel/types.js'

// ===== 配置 =====

export interface RuntimeEventContext {
  traceId: string
  chatId: string
  userId: string
  conversationKey: string
  kind: BaseContext['kind']
  commandName?: string
  messageId?: string
}

export interface AppOptions {
  adapter?: ChannelAdapter
  botId?: string
  secret?: string
  onBusy?: 'drop' | ((ctx: MessageContext) => Promise<void>)
  dispatchMode?: 'parallel' | 'serial' | 'custom'
  scheduler?: Scheduler
  conversationKeyResolver?: (ctx: Pick<BaseContext, 'chatId' | 'userId' | 'kind'>) => string
  logLevel?: 'debug' | 'info' | 'warn' | 'error' | 'silent'
  singleInstance?: boolean
  handlerTimeoutMs?: number
  onError?: (ctx: AppContext, error: Error) => Promise<void>
  onTimeout?: (ctx: AppContext) => Promise<void>
  onRuntimeEvent?: (event: RuntimeEvent) => void | Promise<void>
  /** 会话级 state 保留毫秒；超过未触达的 key 会被周期性清理。默认 30 分钟。设为 0 或负数禁用清理 */
  stateRetentionMs?: number
}

// ===== 回复接口 =====

export type ReplyStreamState = 'idle' | 'streaming' | 'ended' | 'failed'

export interface ReplyStream {
  append(text: string): void
  end(): Promise<void>
  error(message: string): Promise<void>
  getState(): ReplyStreamState
}

export interface CommandInfo {
  readonly name: string
  readonly args?: string
  readonly raw: string
}

export interface BaseContext {
  readonly kind: 'message' | 'command' | 'event'
  readonly command?: CommandInfo
  readonly chatId: string
  readonly userId: string
  readonly conversationKey: string
  readonly traceId: string
  readonly state: Record<string, unknown>
  readonly channelName: string
}

export interface RuntimeEventBase {
  traceId: string
  chatId: string
  userId: string
  conversationKey?: string
  kind: BaseContext['kind']
  commandName?: string
  messageId?: string
}

export type RuntimeEvent =
  | (RuntimeEventBase & { event: 'message.received' })
  | (RuntimeEventBase & { event: 'event.received' })
  | (RuntimeEventBase & { event: 'handler.started'; agentName?: string })
  | (RuntimeEventBase & {
    event: 'handler.completed'
    durationMs: number
    agentName?: string
    inputTokens?: number
    outputTokens?: number
    costUsd?: number
  })
  | (RuntimeEventBase & {
    event: 'handler.failed'
    durationMs: number
    errorName: string
    errorMessage: string
    agentName?: string
  })
  | (RuntimeEventBase & {
    event: 'handler.timed_out'
    durationMs: number
    errorName: string
    errorMessage: string
  })
  | (RuntimeEventBase & { event: 'busy.rejected'; waitMs?: number })
  | (RuntimeEventBase & { event: 'reply.sent'; streamId?: string })
  | (RuntimeEventBase & { event: 'stream.started'; streamId: string })
  | (RuntimeEventBase & { event: 'stream.updated'; streamId: string })
  | (RuntimeEventBase & { event: 'stream.ended'; streamId: string })
  | (RuntimeEventBase & {
    event: 'stream.failed'
    streamId: string
    errorName: string
    errorMessage: string
  })

export type RuntimeEventName = RuntimeEvent['event']

export interface Scheduler {
  dispatch: (
    ctx: MessageContext,
    handler: MessageHandler,
  ) => Promise<void>
}

// ===== 消息上下文 =====

export interface MessageContext extends BaseContext {
  readonly text: string
  readonly msgType: 'text' | 'image' | 'file' | 'voice'
  readonly fileBuffer?: Buffer
  readonly fileName?: string
  readonly raw: unknown
  reply(text: string): Promise<void>
  replyStream(): ReplyStream
}

// ===== 事件上下文 =====

export interface EventContext extends BaseContext {
  readonly raw: unknown
  reply(text: string): Promise<void>
}

// ===== Handler 类型 =====

export type AppContext = MessageContext | EventContext
export type MessageHandler = (ctx: MessageContext) => Promise<void>
export type EventHandler = (ctx: EventContext) => Promise<void>
export type Next = () => Promise<void>
export type Middleware = (ctx: AppContext, next: Next) => Promise<void>

// ===== App 接口 =====

export interface App {
  onMessage(handler: MessageHandler): this
  onCommand(name: string, handler: MessageHandler): this
  onEvent(handler: EventHandler): this
  use(middleware: Middleware): this
  start(): Promise<void>
  stop(): Promise<void>
}

// ===== 内部：消息处理器产出 =====

export interface ProcessedMessage {
  chatId: string
  userId: string
  type: 'text' | 'image' | 'file' | 'voice' | 'unsupported'
  content: string
  fileBuffer?: Buffer
  fileName?: string
  raw: unknown
}
