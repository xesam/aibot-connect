import { setLogLevel, createLogger, type Logger } from '../logger.js'
import { acquireLock, releaseLock } from '../lock.js'
import { WecomChannelAdapter } from '../channel/wecom/adapter.js'
import type { ChannelAdapter, IncomingMessage, IncomingEvent } from '../channel/types.js'
import { Dispatcher } from './dispatcher.js'
import { parseCommand } from './command-parser.js'
import { composeMiddleware } from './middleware.js'
import { createMessageContext, createEventContext } from './context.js'
import {
  createRuntimeEmitter,
  createRuntimeEvent,
  type RuntimeEventContext,
} from './runtime-events.js'
import type {
  App, AppOptions, MessageHandler, EventHandler, ProcessedMessage, Middleware, AppContext, MessageContext, EventContext,
} from '../types.js'
import { toError, isTerminalState } from '../utils.js'

function isMessageContext(ctx: AppContext): ctx is MessageContext {
  return ctx.kind === 'message' || ctx.kind === 'command'
}

/**
 * @internal
 * Pure helper exposed for unit testing. Not part of the public package API —
 * external consumers should not import this from src/core/app.js.
 */
export function cleanupStaleStates(
  map: Map<string, { state: Record<string, unknown>; lastTouchedAt: number }>,
  retentionMs: number,
  now: number = Date.now(),
): number {
  if (retentionMs <= 0) return 0
  const cutoff = now - retentionMs
  let removed = 0
  for (const [key, entry] of map) {
    if (entry.lastTouchedAt < cutoff) {
      map.delete(key)
      removed++
    }
  }
  return removed
}

export function createApp(options: AppOptions = {}): App {
  const resolvedLogLevel = options.logLevel ?? process.env.AIBOT_CONNECT_LOG_LEVEL
  // Set the global `log` singleton level so user code outside the app instance
  // (e.g. standalone scripts) sees the same verbosity.  Per-instance subsystems
  // receive an isolated logger created below and are unaffected by setLogLevel.
  setLogLevel(resolvedLogLevel)
  const logger: Logger = createLogger({ level: resolvedLogLevel })

  const adapterProvided = !!options.adapter
  if (!adapterProvided) {
    const botId = options.botId ?? process.env.WECOM_BOT_ID ?? ''
    const secret = options.secret ?? process.env.WECOM_SECRET ?? ''
    if (!botId || !secret) {
      throw new Error(
        'botId and secret are required when no adapter is provided. ' +
        'Pass them via options, set WECOM_BOT_ID and WECOM_SECRET env vars, or provide a custom adapter.'
      )
    }
  }

  const emitRuntimeEvent = createRuntimeEmitter(options.onRuntimeEvent, logger)
  const dispatcher = new Dispatcher({
    onBusy: options.onBusy,
    onRuntimeEvent: emitRuntimeEvent,
    dispatchMode: options.dispatchMode,
    scheduler: options.scheduler,
    logger,
  })
  const commandHandlers = new Map<string, MessageHandler>()
  const middlewares: Middleware[] = []
  const stateStore = new Map<string, { state: Record<string, unknown>; lastTouchedAt: number }>()
  const stateRetentionMs = options.stateRetentionMs ?? 30 * 60 * 1000
  let stateCleanupTimer: ReturnType<typeof setInterval> | null = null
  let messageHandler: MessageHandler | undefined
  let eventHandler: EventHandler | undefined

  function resolveConversationKey(
    context: Pick<MessageContext, 'chatId' | 'userId' | 'kind'>,
  ): string {
    if (options.conversationKeyResolver) {
      return options.conversationKeyResolver(context)
    }
    if (!context.chatId || context.chatId === context.userId) {
      return `dm:${context.userId}`
    }
    return `group:${context.chatId}:user:${context.userId}`
  }

  function getState(conversationKey: string): Record<string, unknown> {
    let entry = stateStore.get(conversationKey)
    const now = Date.now()
    if (!entry) {
      entry = { state: {}, lastTouchedAt: now }
      stateStore.set(conversationKey, entry)
    } else {
      entry.lastTouchedAt = now
    }
    return entry.state
  }

  async function applyDefaultError(ctx: AppContext, error: Error): Promise<void> {
    if (isMessageContext(ctx)) {
      const stream = ctx.replyStream()
      if (!isTerminalState(stream.getState())) {
        await stream.error(`处理出错：${error.message}`)
      }
      return
    }

    await ctx.reply(`处理出错：${error.message}`)
  }

  async function executeWithPolicies<T extends AppContext>(
    ctx: T,
    handler: (ctx: T) => Promise<void>,
  ): Promise<void> {
    const timeoutMs = options.handlerTimeoutMs
    const runtimeContext = toRuntimeContext(ctx)
    const startedAt = Date.now()
    const runHandler = async (): Promise<void> => {
      await handler(ctx)
    }

    try {
      emitRuntimeEvent(createRuntimeEvent(runtimeContext, 'handler.started'))
      if (!timeoutMs || timeoutMs <= 0) {
        await runHandler()
        emitRuntimeEvent(createRuntimeEvent(runtimeContext, 'handler.completed', {
          durationMs: Date.now() - startedAt,
        }))
        return
      }

      let timeoutId: ReturnType<typeof setTimeout> | undefined
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`Handler timed out after ${timeoutMs}ms`)), timeoutMs)
      })
      try {
        await Promise.race([runHandler(), timeoutPromise])
      } finally {
        clearTimeout(timeoutId)
      }
      emitRuntimeEvent(createRuntimeEvent(runtimeContext, 'handler.completed', {
        durationMs: Date.now() - startedAt,
      }))
    } catch (error) {
      const resolved = toError(error)
      const isTimeout = timeoutMs && resolved.message === `Handler timed out after ${timeoutMs}ms`

      if (isTimeout) {
        emitRuntimeEvent(createRuntimeEvent(runtimeContext, 'handler.timed_out', {
          durationMs: Date.now() - startedAt,
          errorName: resolved.name,
          errorMessage: resolved.message,
        }))
        if (options.onTimeout) {
          try {
            await options.onTimeout(ctx)
          } catch (timeoutHookError) {
            logger.error(`[App] onTimeout hook error: ${toError(timeoutHookError).message}`)
          }
        }

        await applyDefaultError(ctx, resolved)
        return
      }

      emitRuntimeEvent(createRuntimeEvent(runtimeContext, 'handler.failed', {
        durationMs: Date.now() - startedAt,
        errorName: resolved.name,
        errorMessage: resolved.message,
      }))
      if (options.onError) {
        try {
          await options.onError(ctx, resolved)
        } catch (hookError) {
          logger.error(`[App] onError hook error: ${toError(hookError).message}`)
        }
      }

      await applyDefaultError(ctx, resolved)
    }
  }

  async function handleIncomingMessage(msg: IncomingMessage): Promise<void> {
    const parsed = msg.type === 'text'
      ? parseCommand(msg.content)
      : { isCommand: false as const }
    const command = parsed.isCommand && parsed.command
      ? { name: parsed.command, args: parsed.args, raw: msg.content }
      : undefined
    const cmdHandler = command ? commandHandlers.get(command.name) : undefined
    const kind = cmdHandler ? 'command' : 'message'
    const conversationKey = resolveConversationKey({ kind, chatId: msg.chatId, userId: msg.userId })
    const runtimeContext: RuntimeEventContext = {
      traceId: msg.traceId,
      chatId: msg.chatId,
      userId: msg.userId,
      conversationKey,
      kind,
      commandName: command?.name,
      messageId: msg.messageId,
    }
    emitRuntimeEvent(createRuntimeEvent(runtimeContext, 'message.received'))

    const sender = msg.senderFactory.makeSender(runtimeContext)
    const processed: ProcessedMessage = {
      chatId: msg.chatId,
      userId: msg.userId,
      type: msg.type,
      content: msg.content,
      fileBuffer: msg.fileBuffer,
      fileName: msg.fileName,
      raw: msg.raw,
    }
    const ctx = createMessageContext(
      processed,
      sender,
      getState(conversationKey),
      conversationKey,
      msg.traceId,
      msg.channelName,
      cmdHandler ? command : undefined,
    )

    // 命令优先
    if (cmdHandler) {
      const wrappedCommand: (ctx: AppContext) => Promise<void> = async (c) => {
        await cmdHandler(c as MessageContext)
      }
      const commandPipeline = middlewares.length > 0
        ? composeMiddleware(middlewares, wrappedCommand)
        : wrappedCommand
      await dispatcher.dispatch(ctx, (messageCtx) => executeWithPolicies(messageCtx, commandPipeline))
      return
    }

    if (msg.type === 'unsupported') {
      await sender.reply(msg.content)
      return
    }

    if (messageHandler) {
      const handler = messageHandler
      const wrappedMessage: (ctx: AppContext) => Promise<void> = async (c) => {
        await handler(c as MessageContext)
      }
      const messagePipeline = middlewares.length > 0
        ? composeMiddleware(middlewares, wrappedMessage)
        : wrappedMessage
      await dispatcher.dispatch(ctx, (messageCtx) => executeWithPolicies(messageCtx, messagePipeline))
    }
  }

  async function handleIncomingEvent(evt: IncomingEvent): Promise<void> {
    if (!eventHandler) return

    const conversationKey = resolveConversationKey({ kind: 'event', chatId: evt.chatId, userId: evt.userId })
    const runtimeContext: RuntimeEventContext = {
      traceId: evt.traceId,
      chatId: evt.chatId,
      userId: evt.userId,
      conversationKey,
      kind: 'event',
      messageId: evt.messageId,
    }
    emitRuntimeEvent(createRuntimeEvent(runtimeContext, 'event.received'))

    const sender = evt.senderFactory.makeSender(runtimeContext)
    const ctx = createEventContext(
      evt.raw,
      evt.chatId,
      evt.userId,
      sender,
      getState(conversationKey),
      conversationKey,
      evt.traceId,
      evt.channelName,
    )

    const handler = eventHandler
    const wrappedEvent: (ctx: AppContext) => Promise<void> = async (c) => {
      await handler(c as EventContext)
    }
    const eventPipeline = middlewares.length > 0
      ? composeMiddleware(middlewares, wrappedEvent)
      : wrappedEvent
    await executeWithPolicies(ctx, eventPipeline)
  }

  const adapter: ChannelAdapter = options.adapter ?? new WecomChannelAdapter({
    botId: options.botId ?? process.env.WECOM_BOT_ID ?? '',
    secret: options.secret ?? process.env.WECOM_SECRET ?? '',
    logger,
    emitRuntimeEvent,
  })

  const app: App = {
    onMessage(handler: MessageHandler): App {
      messageHandler = handler
      return app
    },

    onEvent(handler: EventHandler): App {
      eventHandler = handler
      return app
    },

    use(middleware: Middleware): App {
      middlewares.push(middleware)
      return app
    },

    onCommand(name: string, handler: MessageHandler): App {
      commandHandlers.set(name.toLowerCase(), handler)
      return app
    },

    async start(): Promise<void> {
      if (options.singleInstance !== false) {
        await acquireLock()
      }

      if (stateRetentionMs > 0) {
        // Guard against double-start without intervening stop() — would otherwise orphan the previous timer.
        if (stateCleanupTimer) {
          clearInterval(stateCleanupTimer)
        }
        stateCleanupTimer = setInterval(() => {
          const removed = cleanupStaleStates(stateStore, stateRetentionMs)
          if (removed > 0) {
            logger.debug(`[App] Cleaned up ${removed} stale conversation state(s)`)
          }
        }, 60_000)
        stateCleanupTimer.unref()
      }

      try {
        logger.info('[App] Starting...')
        await adapter.start({ onMessage: handleIncomingMessage, onEvent: handleIncomingEvent })
        logger.info(`[App] Service started (channel: ${adapter.name})`)
      } catch (error) {
        if (options.singleInstance !== false) {
          await releaseLock()
        }
        if (stateCleanupTimer) {
          clearInterval(stateCleanupTimer)
          stateCleanupTimer = null
        }
        throw error
      }
    },

    async stop(): Promise<void> {
      try {
        await adapter.stop()
      } finally {
        if (stateCleanupTimer) {
          clearInterval(stateCleanupTimer)
          stateCleanupTimer = null
        }
        if (options.singleInstance !== false) {
          await releaseLock()
        }
        logger.info('[App] Service stopped')
      }
    },
  }

  return app
}

function toRuntimeContext(ctx: AppContext): RuntimeEventContext {
  return {
    traceId: ctx.traceId,
    chatId: ctx.chatId,
    userId: ctx.userId,
    conversationKey: ctx.conversationKey,
    kind: ctx.kind,
    commandName: ctx.command?.name,
  }
}
