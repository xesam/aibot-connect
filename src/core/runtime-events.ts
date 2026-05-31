import { log, type Logger } from '../logger.js'
import type { AppOptions, RuntimeEvent, RuntimeEventBase } from '../types.js'
import { toErrorMessage } from '../utils.js'

// Re-exported from types.ts for backward compat — do not remove
export type { RuntimeEventContext } from '../types.js'
import type { RuntimeEventContext } from '../types.js'

export function createRuntimeEmitter(
  sink?: AppOptions['onRuntimeEvent'],
  logger: Logger = log,
): (event: RuntimeEvent) => void {
  return (event: RuntimeEvent): void => {
    logRuntimeEvent(event, logger)

    if (!sink) return

    try {
      const maybePromise = sink(event)
      if (maybePromise && typeof maybePromise === 'object' && 'catch' in maybePromise) {
        ;(maybePromise as Promise<void>).catch((error) => {
          logger.error(`[Runtime] Event sink error: ${toErrorMessage(error)}`)
        })
      }
    } catch (error) {
      logger.error(`[Runtime] Event sink error: ${toErrorMessage(error)}`)
    }
  }
}

export type RuntimeEventExtras<T extends RuntimeEvent['event']> = Omit<
  Extract<RuntimeEvent, { event: T }>,
  keyof RuntimeEventBase | 'event'
>

export function createRuntimeEvent<T extends RuntimeEvent['event']>(
  ctx: RuntimeEventContext,
  event: T,
  extras: RuntimeEventExtras<T> = {} as RuntimeEventExtras<T>,
): Extract<RuntimeEvent, { event: T }> {
  return {
    event,
    traceId: ctx.traceId,
    chatId: ctx.chatId,
    userId: ctx.userId,
    conversationKey: ctx.conversationKey,
    kind: ctx.kind,
    commandName: ctx.commandName,
    messageId: ctx.messageId,
    ...extras,
  } as Extract<RuntimeEvent, { event: T }>
}

function logRuntimeEvent(event: RuntimeEvent, logger: Logger): void {
  const base = `[Runtime] ${event.event} traceId=${event.traceId} chatId=${event.chatId} kind=${event.kind}`

  if (event.event === 'handler.failed' || event.event === 'stream.failed') {
    logger.error(`${base} error=${event.errorMessage}`)
    return
  }

  if (event.event === 'handler.timed_out') {
    logger.warn(`${base} durationMs=${event.durationMs}`)
    return
  }

  if (event.event === 'busy.rejected') {
    logger.warn(`${base}${event.waitMs !== undefined ? ` waitMs=${event.waitMs}` : ''}`)
    return
  }

  logger.debug(base)
}
