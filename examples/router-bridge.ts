/**
 * RouterAgent 桥接示例：使用路由代理将 Claude Code 和 Codex 两个 Agent 拆分开，
 * 通过自定义路由逻辑决定每个请求交给谁处理。
 *
 * 运行前准备：
 *   1. 复制 .env.example 为 .env 并填写 WECOM_BOT_ID / WECOM_SECRET
 *   2. 确保 claude 和 codex CLI 已安装并可用
 *   3. 运行：npx tsx examples/router-bridge.ts
 */
import {
  createApp,
  ClaudeCodeCliAgent,
  CodexCliAgent,
  RouterAgent,
} from 'aibot-connect'

import type { MessageContext } from 'aibot-connect'

// ============================================================
// 1. 创建 Claude Code CLI Agent
// ============================================================
const claudeAgent = new ClaudeCodeCliAgent({
  cwd: process.cwd(),
  // 模型：不设置则使用 Claude Code 默认模型
  // model: 'claude-sonnet-4-20250514',
  // 允许的工具列表
  allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
  // 最大对话轮数
  maxTurns: 20,
})

// ============================================================
// 2. 创建 Codex CLI Agent
// ============================================================
const codexAgent = new CodexCliAgent({
  cwd: process.cwd(),
  // 模型：不设置则使用 Codex 默认模型
  // model: 'gpt-5-codex',
})

// ============================================================
// 3. 创建 RouterAgent，配备自定义路由逻辑
//    根据消息内容决定交给哪个 Agent
// ============================================================
const router = new RouterAgent({
  agents: {
    claude: claudeAgent,
    codex: codexAgent,
  },
  // 没有命中路由规则时的默认 Agent
  defaultAgent: 'claude',

  // 自定义路由函数：根据消息关键词分派 Agent
  //   - 消息以 "@codex" 开头 或包含 "用codex" → Codex
  //   - 消息包含 "多文件" / "重构" / "复杂" → Codex（大范围任务更适合 Codex）
  //   - 其余情况 → 默认走 Claude
  route: async (ctx: MessageContext): Promise<string> => {
    const text = ctx.text.trim()

    // 显式指定：以 @codex 开头
    if (text.startsWith('@codex')) {
      return 'codex'
    }

    // 复杂/大范围任务更适合 Codex
    if (
      text.includes('多文件') ||
      text.includes('重构') ||
      text.includes('复杂')
    ) {
      return 'codex'
    }

    // 默认走 Claude
    return 'claude'
  },

  // 会话过期时间（分钟），超时自动清理
  sessionTimeoutMin: 60,

  // 运行时事件回调：打印是哪个 Agent 在处理消息
  onRuntimeEvent: (event) => {
    if (event.event === 'handler.started') {
      console.log(`[router] ${event.chatId} → ${event.agentName}`)
    }
  },
})

// ============================================================
// 4. 创建 App 实例
// ============================================================
const app = createApp({
  // botId / secret 从 .env 自动加载，也可直接传入
  onBusy: async (ctx) => {
    // 当会话正在处理中时，告知用户稍候
    await ctx.reply('正在处理上一条消息，请稍候...')
  },
})

// ============================================================
// 5. 注册 onMessage / onEvent —— 一行交给 RouterAgent 接管
//    router.handle 处理消息（命令 / 路由 / 流式回复）
//    router.handleEvent 处理事件（入群欢迎语）
// ============================================================
app.onMessage(async (ctx) => {
  await router.handle(ctx)
})

app.onEvent(async (ctx) => {
  await router.handleEvent(ctx)
})

// ============================================================
// 7. 审计日志中间件（在路由之前记录每条消息）
// ============================================================
app.use(async (ctx, next) => {
  const now = new Date().toISOString()

  if (ctx.kind === 'event') {
    console.info(
      '[AUDIT]',
      JSON.stringify({
        ts: now,
        traceId: ctx.traceId,
        kind: 'event',
        chatId: ctx.chatId,
        userId: ctx.userId,
        action: 'enter_chat',
      }),
    )
    return next()
  }

  // 截断过长的消息
  const text =
    ctx.text.length > 200 ? `${ctx.text.slice(0, 200)}...(截断)` : ctx.text

  console.info(
    '[AUDIT]',
    JSON.stringify({
      ts: now,
      traceId: ctx.traceId,
      kind: ctx.kind,
      chatId: ctx.chatId,
      userId: ctx.userId,
      command: ctx.command?.name ?? null,
      text,
    }),
  )

  await next()
})

// ============================================================
// 8. 启动服务 & 优雅关闭
// ============================================================
await app.start()
console.log('[router-bridge] 服务已启动，等待消息...')

process.on('SIGINT', async () => {
  console.log('\n[router-bridge] 收到 SIGINT，正在关闭...')
  await app.stop()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  console.log('\n[router-bridge] 收到 SIGTERM，正在关闭...')
  await app.stop()
  process.exit(0)
})
