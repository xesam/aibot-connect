import AiBot, { type WSClient, type WsFrame, type BaseMessage } from '@wecom/aibot-node-sdk'
import { log, type Logger } from '../../logger.js'
import { WecomMessageProcessor } from './message-processor.js'
import type { ProcessedMessage } from '../../types.js'
import { toError, toErrorMessage } from '../../utils.js'

export type WecomEventType = 'enter_chat'

export interface WecomClientOptions {
  botId: string
  secret: string
  logger?: Logger
}

export interface WecomClientCallbacks {
  onMessage: (processed: ProcessedMessage, frame: WsFrame<BaseMessage>) => Promise<void>
  onEvent: (eventType: WecomEventType, frame: WsFrame) => Promise<void>
}

export class WecomClient {
  private ws: WSClient
  private processor: WecomMessageProcessor
  private callbacks: WecomClientCallbacks
  private readyPromise: Promise<void> | null = null
  private resolveReady: (() => void) | null = null
  private rejectReady: ((error: Error) => void) | null = null
  private isReadyCyclePending = false
  private isReady = false
  private logger: Logger

  constructor(options: WecomClientOptions, callbacks: WecomClientCallbacks) {
    this.logger = options.logger ?? log
    this.ws = new AiBot.WSClient({
      botId: options.botId,
      secret: options.secret,
      logger: this.logger,
    })
    this.processor = new WecomMessageProcessor(this.ws, this.logger)
    this.callbacks = callbacks
    this.setupEventHandlers()
  }

  getWsClient(): WSClient {
    return this.ws
  }

  connect(): void {
    this.resetReadyCycle()
    this.ws.connect()
  }

  waitUntilReady(): Promise<void> {
    if (!this.readyPromise) {
      throw new Error('waitUntilReady() called before connect()')
    }
    return this.readyPromise
  }

  disconnect(): void {
    this.ws.disconnect()
  }

  private setupEventHandlers(): void {
    this.ws.on('connected', () => {
      this.logger.info('[WecomClient] WebSocket connected')
    })
    this.ws.on('authenticated', () => {
      this.logger.info('[WecomClient] WebSocket authenticated')
      this.resolveCurrentReadyCycle()
    })
    this.ws.on('disconnected', (reason) => {
      this.logger.info(`[WecomClient] WebSocket disconnected: ${reason}`)
      this.rejectCurrentReadyCycle(new Error(`WebSocket disconnected before ready: ${reason}`))
    })
    this.ws.on('reconnecting', (attempt) => {
      this.logger.info(`[WecomClient] Reconnecting... attempt ${attempt}`)
    })
    this.ws.on('error', (error) => {
      this.logger.error(`[WecomClient] WebSocket error: ${toErrorMessage(error)}`)
      this.rejectCurrentReadyCycle(toError(error))
    })

    for (const msgEvent of ['message.text', 'message.image', 'message.file', 'message.voice'] as const) {
      this.ws.on(msgEvent, (frame) => {
        this.processor.process(frame as WsFrame<BaseMessage>)
          .then((processed) => this.callbacks.onMessage(processed, frame as WsFrame<BaseMessage>))
          .catch((error: unknown) => {
            this.logger.error(`[WecomClient] Message handling error: ${toErrorMessage(error)}`)
          })
      })
    }

    this.ws.on('event.enter_chat', (frame) => {
      this.callbacks.onEvent('enter_chat', frame)
        .catch((error: unknown) => {
          this.logger.error(`[WecomClient] Event handling error: ${toErrorMessage(error)}`)
        })
    })
  }

  private resetReadyCycle(): void {
    this.isReady = false
    this.isReadyCyclePending = true
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve
      this.rejectReady = reject
    })
  }

  private resolveCurrentReadyCycle(): void {
    if (!this.isReadyCyclePending || !this.resolveReady) {
      return
    }

    this.isReady = true
    this.isReadyCyclePending = false
    this.resolveReady()
  }

  private rejectCurrentReadyCycle(error: Error): void {
    if (!this.isReadyCyclePending || !this.rejectReady || this.isReady) {
      return
    }

    this.isReadyCyclePending = false
    this.rejectReady(error)
  }
}

