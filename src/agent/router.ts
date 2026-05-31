import { join } from 'node:path'
import type { CommandInfo, EventContext, MessageContext, RuntimeEvent } from '../types.js'
import { log, type Logger } from '../logger.js'
import { toErrorMessage } from '../utils.js'
import { parseCommand } from '../core/command-parser.js'
import type { RuntimeEventExtras } from '../core/runtime-events.js'
import type { Agent, AgentMessage, RouterConfig } from './types.js'
import { type SessionStore, type SessionEntry, FileSessionStore } from './session-store.js'

const DEFAULT_FILE_PATH = join(process.cwd(), 'data', 'sessions.json')

interface StreamResult {
  agentSessionId: string
  totalInputTokens: number
  totalOutputTokens: number
  totalCostUsd: number
  streamStarted: boolean
}

export class RouterAgent {
  private agents: Record<string, Agent>
  private defaultAgent: string
  private routeFn: (ctx: MessageContext) => string | Promise<string>
  private sessionStore: SessionStore
  private abortControllers: Map<string, AbortController> = new Map()
  private initPromise: Promise<void> | null = null
  private emitRuntimeEvent?: (event: RuntimeEvent) => void
  private displayName: string
  private logger: Logger

  constructor(config: RouterConfig) {
    this.agents = config.agents
    this.defaultAgent = config.defaultAgent
    this.routeFn = config.route ?? (() => this.defaultAgent)
    this.displayName = config.displayName ?? 'aibot connect'
    this.logger = config.logger ?? log
    this.emitRuntimeEvent = config.onRuntimeEvent
      ? (event) => { void config.onRuntimeEvent!(event) }
      : undefined

    this.sessionStore = config.sessionStore ?? new FileSessionStore({
      filePath: DEFAULT_FILE_PATH,
      sessionTimeoutMin: config.sessionTimeoutMin,
      logger: this.logger,
    })

    if (!this.agents[this.defaultAgent]) {
      throw new Error(`defaultAgent "${this.defaultAgent}" not found in agents`)
    }
  }

  private emitEvent<T extends RuntimeEvent['event']>(
    ctx: MessageContext,
    event: T,
    extras: RuntimeEventExtras<T> = {} as RuntimeEventExtras<T>,
  ): void {
    if (!this.emitRuntimeEvent) return
    this.emitRuntimeEvent({
      event,
      traceId: ctx.traceId,
      chatId: ctx.chatId,
      userId: ctx.userId,
      conversationKey: ctx.conversationKey,
      kind: ctx.kind,
      commandName: ctx.command?.name,
      ...extras,
    } as Extract<RuntimeEvent, { event: T }>)
  }

  async handle(ctx: MessageContext): Promise<void> {
    await this.ensureInit()

    if (ctx.command) {
      await this.handleCommand(ctx)
      return
    }

    const command = this.parseBuiltinCommand(ctx.text)
    if (command) {
      await this.handleCommand(ctx, command)
      return
    }

    const agentName = await this.routeFn(ctx)
    const agent = this.agents[agentName]
    if (!agent) {
      await ctx.reply(`未知 Agent: ${agentName}`)
      return
    }

    const existingSession = this.sessionStore.get(ctx.chatId)

    const abortController = new AbortController()
    this.abortControllers.set(ctx.conversationKey, abortController)

    const startedAt = Date.now()
    this.emitEvent(ctx, 'handler.started', { agentName })

    try {
      const stream = agent.query(ctx.text, {
        resume: existingSession?.agentName === agentName ? existingSession.agentSessionId : undefined,
        abortController,
      })

      const result = await this.processAgentStream(stream, ctx, agentName, existingSession, startedAt)

      if (result.agentSessionId) {
        this.persistSession(ctx.chatId, agentName, result, existingSession)
      }
    } catch (error) {
      const errMsg = toErrorMessage(error)
      this.logger.error(`[Router] Handler error: ${errMsg}`)

      // processAgentStream may have started streaming before throwing;
      // check sender state to decide the correct reply path
      const rs = ctx.replyStream()
      if (rs.getState() === 'streaming') {
        await rs.error(errMsg)
      } else {
        await ctx.reply(`出错了：${errMsg}`)
      }

      this.emitEvent(ctx, 'handler.failed', {
        durationMs: Date.now() - startedAt,
        errorName: 'RouterError',
        errorMessage: errMsg,
        agentName,
      })
    } finally {
      if (this.abortControllers.get(ctx.conversationKey) === abortController) {
        this.abortControllers.delete(ctx.conversationKey)
      }
    }
  }

  async handleEvent(ctx: EventContext): Promise<void> {
    await this.ensureInit()
    const agentList = Object.keys(this.agents).join('、')
    await ctx.reply(`你好！我是 ${this.displayName}。\n\n当前可用 Agent：${agentList}\n发送 /help 查看命令。`)
  }

  private async processAgentStream(
    stream: AsyncIterable<AgentMessage>,
    ctx: MessageContext,
    agentName: string,
    existingSession: SessionEntry | undefined,
    startedAt: number,
  ): Promise<StreamResult> {
    let agentSessionId = ''
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCostUsd = 0
    let streamStarted = false
    const rs = ctx.replyStream()

    loop: for await (const msg of stream) {
      switch (msg.type) {
        case 'session':
          agentSessionId = msg.sessionId
          break

        case 'text':
          rs.append(msg.text)
          streamStarted = true
          break

        case 'tool_call':
          this.logger.info(`[Router] ${agentName} tool call: ${msg.toolName}`)
          break

        case 'done': {
          totalCostUsd = msg.costUsd ?? 0
          totalInputTokens = msg.usage?.inputTokens ?? 0
          totalOutputTokens = msg.usage?.outputTokens ?? 0

          if (streamStarted) {
            await rs.end()
          } else {
            await ctx.reply('（无输出）')
          }

          this.emitEvent(ctx, 'handler.completed', {
            durationMs: Date.now() - startedAt,
            agentName,
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            costUsd: totalCostUsd,
          })
          break loop
        }

        case 'error': {
          this.logger.error(`[Router] Agent error: ${msg.message}`)

          if (existingSession && existingSession.agentName === agentName) {
            this.sessionStore.delete(ctx.chatId)
            this.logger.info(`[Router] Cleared stale session for ${ctx.chatId} after resume failure`)
          }

          if (streamStarted) {
            await rs.error(msg.message)
          } else {
            await ctx.reply(`出错了：${msg.message}`)
          }

          this.emitEvent(ctx, 'handler.failed', {
            durationMs: Date.now() - startedAt,
            errorName: 'AgentError',
            errorMessage: msg.message,
            agentName,
          })
          break loop
        }
      }
    }

    return { agentSessionId, totalInputTokens, totalOutputTokens, totalCostUsd, streamStarted }
  }

  private persistSession(
    chatId: string,
    agentName: string,
    result: StreamResult,
    existingSession: SessionEntry | undefined,
  ): void {
    const now = Date.now()
    const isAgentSwitch = !!existingSession && existingSession.agentName !== agentName

    if (!existingSession || isAgentSwitch) {
      // New session start: either first message ever or user switched agent
      this.sessionStore.set(chatId, {
        chatId,
        agentName,
        agentSessionId: result.agentSessionId,
        totalInputTokens: result.totalInputTokens,
        totalOutputTokens: result.totalOutputTokens,
        totalCostUsd: result.totalCostUsd,
        lastActiveTime: now,
        createdAt: now,
      })
    } else {
      // Continuing with same agent: accumulate usage
      this.sessionStore.set(chatId, {
        ...existingSession,
        agentSessionId: result.agentSessionId,
        agentName,
        totalInputTokens: existingSession.totalInputTokens + result.totalInputTokens,
        totalOutputTokens: existingSession.totalOutputTokens + result.totalOutputTokens,
        totalCostUsd: existingSession.totalCostUsd + result.totalCostUsd,
        lastActiveTime: now,
      })
    }
  }

  reset(chatId: string): void {
    this.sessionStore.delete(chatId)
  }

  stop(conversationKey: string): void {
    const controller = this.abortControllers.get(conversationKey)
    if (controller) {
      controller.abort()
      // cleanup is owned by the finally block in handle()
    }
  }

  status(chatId: string): string {
    const session = this.sessionStore.get(chatId)
    if (!session) return '当前无活跃会话。'

    return [
      `**会话状态**`,
      `Agent: ${session.agentName}`,
      `Session: ${session.agentSessionId.slice(0, 8)}...`,
      `Token: ${session.totalInputTokens.toLocaleString()} in / ${session.totalOutputTokens.toLocaleString()} out`,
      `费用: $${session.totalCostUsd.toFixed(4)}`,
      `创建: ${new Date(session.createdAt).toLocaleString('zh-CN')}`,
      `最后活跃: ${new Date(session.lastActiveTime).toLocaleString('zh-CN')}`,
    ].join('\n')
  }

  private static readonly BUILTIN_COMMANDS = new Set(['help', 'reset', 'stop', 'status'])

  /** 自行解析内置命令，不依赖框架的 onCommand 注册 */
  private parseBuiltinCommand(text: string): CommandInfo | undefined {
    const parsed = parseCommand(text)
    if (!parsed.isCommand || !parsed.command) return undefined
    if (!RouterAgent.BUILTIN_COMMANDS.has(parsed.command)) return undefined

    return { name: parsed.command, args: parsed.args, raw: text }
  }

  private async handleCommand(ctx: MessageContext, commandOverride?: CommandInfo): Promise<void> {
    const cmd = commandOverride ?? ctx.command!
    switch (cmd.name) {
      case 'reset':
        this.reset(ctx.chatId)
        await ctx.reply('会话已重置，下次对话将开启新会话。')
        break
      case 'stop':
        this.stop(ctx.conversationKey)
        await ctx.reply('已中断当前任务。')
        break
      case 'status':
        await ctx.reply(this.status(ctx.chatId))
        break
      case 'help':
        await ctx.reply(
          '/reset - 重置当前会话\n' +
          '/stop - 中断正在执行的任务\n' +
          '/status - 查看会话状态和用量统计'
        )
        break
    }
  }

  private ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.sessionStore.init()
    }
    return this.initPromise
  }

  async dispose(): Promise<void> {
    await this.sessionStore.dispose()
  }
}
