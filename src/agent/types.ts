import type { MessageContext, RuntimeEvent } from '../types.js'
import type { Logger } from '../logger.js'
import type { SessionStore } from './session-store.js'

// ===== Agent 抽象接口 =====

export interface AgentOptions {
  /** 工作目录（未填时回退到 Agent 构造时的 cwd） */
  cwd?: string
  /** 恢复会话的 sessionId（undefined = 新会话） */
  resume?: string
  /** 取消控制器 */
  abortController?: AbortController
}

export type AgentMessage =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolName: string; input: Record<string, unknown> }
  | { type: 'session'; sessionId: string }
  | { type: 'error'; message: string }
  | { type: 'done'; costUsd?: number; usage?: { inputTokens: number; outputTokens: number } }

export type AgentStream = AsyncIterable<AgentMessage>

export interface Agent {
  /** Agent 名称 */
  readonly name: string
  /** 发起查询，返回流式消息 */
  query(prompt: string, options: AgentOptions): AgentStream
}

// ===== 各 Agent 配置类型 =====

interface BaseCliConfig {
  cwd: string
  model?: string
  allowedTools?: string[]
  maxTurns?: number
}

export interface ClaudeCodeCliConfig extends BaseCliConfig {}

export interface ClaudeCodeSdkConfig extends BaseCliConfig {
  /** 单次会话费用上限（美元） */
  maxBudgetUsd?: number
}

export interface CodexCliConfig {
  /** 工作目录 */
  cwd: string
  /** Codex 模型 (--model) */
  model?: string
}

// ===== RouterAgent 配置 =====

export interface RouterConfig {
  /** 名称 → Agent 实例 */
  agents: Record<string, Agent>
  /** 默认使用的 Agent 名称 */
  defaultAgent: string
  /** 助手展示名称，用于欢迎语等场景，默认 "aibot connect" */
  displayName?: string
  /** 自定义路由逻辑，默认全部走 defaultAgent */
  route?: (ctx: MessageContext) => string | Promise<string>
  /** 会话过期分钟数，默认 480（8 小时） */
  sessionTimeoutMin?: number
  /** 运行时事件回调，用于监控 Agent 调用 */
  onRuntimeEvent?: (event: RuntimeEvent) => void | Promise<void>
  /** 会话存储实现，默认 FileSessionStore（path=data/sessions.json，过期 480 分钟） */
  sessionStore?: SessionStore
  /** 日志记录器；默认全局 log */
  logger?: Logger
}
