import type { MessageContext, MessageHandler, RuntimeEvent } from '../types.js'
import { log, type Logger } from '../logger.js'
import { createRuntimeEvent, type RuntimeEventContext } from './runtime-events.js'
import { toErrorMessage, isTerminalState } from '../utils.js'

export class Dispatcher {
  private processingConversations: Set<string> = new Set()
  private onBusy?: 'drop' | ((ctx: MessageContext) => Promise<void>)
  private emitRuntimeEvent?: (event: RuntimeEvent) => void
  private dispatchMode: 'parallel' | 'serial' | 'custom'
  private scheduler?: {
    dispatch: (ctx: MessageContext, handler: MessageHandler) => Promise<void>
  }
  private logger: Logger

  constructor(options: {
    onBusy?: 'drop' | ((ctx: MessageContext) => Promise<void>)
    onRuntimeEvent?: (event: RuntimeEvent) => void
    dispatchMode?: 'parallel' | 'serial' | 'custom'
    scheduler?: {
      dispatch: (ctx: MessageContext, handler: MessageHandler) => Promise<void>
    }
    logger?: Logger
  }) {
    this.onBusy = options.onBusy
    this.emitRuntimeEvent = options.onRuntimeEvent
    this.dispatchMode = options.dispatchMode ?? 'serial'
    this.scheduler = options.scheduler
    this.logger = options.logger ?? log
  }

  async dispatch(ctx: MessageContext, handler: MessageHandler): Promise<void> {
    if (this.dispatchMode === 'parallel') {
      await this.execute(ctx, handler)
      return
    }

    if (this.dispatchMode === 'custom') {
      if (!this.scheduler) {
        throw new Error('dispatchMode "custom" requires scheduler')
      }
      await this.scheduler.dispatch(ctx, async (nextCtx) => this.execute(nextCtx, handler))
      return
    }

    if (this.processingConversations.has(ctx.conversationKey)) {
      await this.handleBusy(ctx)
      return
    }

    this.processingConversations.add(ctx.conversationKey)
    try {
      await this.execute(ctx, handler)
    } finally {
      this.processingConversations.delete(ctx.conversationKey)
    }
  }

  private async execute(ctx: MessageContext, handler: MessageHandler): Promise<void> {
    try {
      await handler(ctx)
    } catch (error) {
      // 安全网：正常错误已在 executeWithPolicies 中处理，此处仅记录未预期的框架级异常
      this.logger.error(`[Dispatcher] Unexpected handler error: ${toErrorMessage(error)}`)
      const stream = ctx.replyStream()
      if (!isTerminalState(stream.getState())) {
        await stream.error(`处理出错：${toErrorMessage(error)}`)
      }
    }
  }

  private async handleBusy(ctx: MessageContext): Promise<void> {
    this.emitRuntimeEvent?.(createRuntimeEvent(toRuntimeContext(ctx), 'busy.rejected'))
    if (this.onBusy === 'drop' || this.onBusy === undefined) {
      return
    }
    try {
      await this.onBusy(ctx)
    } catch (error) {
      this.logger.error('[Dispatcher] onBusy handler error:', error)
    }
  }
}

function toRuntimeContext(ctx: MessageContext): RuntimeEventContext {
  return {
    traceId: ctx.traceId,
    chatId: ctx.chatId,
    userId: ctx.userId,
    conversationKey: ctx.conversationKey,
    kind: ctx.kind,
    commandName: ctx.command?.name,
  }
}
