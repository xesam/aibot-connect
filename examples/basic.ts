/**
 * 基础示例：启动前复制 .env.example 为 .env 并填写企业微信机器人凭证。
 * 运行：npx tsx examples/basic.ts
 */

import { createApp } from 'aibot-connect'
// 可按需导入类型：AppContext, MessageContext, EventContext, RuntimeEvent, ReplyStream 等
// import type { AppContext, RuntimeEvent } from 'aibot-connect'

// ===== 1. 创建应用实例 =====
// createApp 接收 AppOptions 配置，只需 botId + secret（可从环境变量自动读取）。
// 有关 AppOptions 的所有字段，参见 src/types.ts 中的 AppOptions 接口。
const app = createApp({
  // 日志级别：debug / info / warn / error / silent（默认读取 AIBOT_CONNECT_LOG_LEVEL 环境变量）
  logLevel: 'info',

  // 单次消息处理超时（毫秒），超过后触发 onTimeout 并自动回复错误
  handlerTimeoutMs: 30_000,

  // botId 与 secret：留空时自动从 WECOM_BOT_ID / WECOM_SECRET 环境变量读取
  // botId: 'your-bot-id',
  // secret: 'your-secret',

  // 同一会话在处理前一条消息期间收到新消息时触发
  // 设为 'drop' 表示静默丢弃新消息，设为函数可自定义回复
  onBusy: async (ctx) => {
    await ctx.reply('正在处理上一条消息，请稍候...')
  },

  // handler 内部抛出异常时触发，可用于错误记录或自定义回复。
  // 框架会在此回调完成之后自动向用户回复错误提示。
  onError: async (ctx, error) => {
    console.error(`[ERROR] traceId=${ctx.traceId} kind=${ctx.kind} ${error.message}`)
  },

  // handler 执行超时时触发
  onTimeout: async (ctx) => {
    console.warn(`[TIMEOUT] traceId=${ctx.traceId} kind=${ctx.kind}`)
  },

  // 接收所有运行时事件，可用于监控/告警/日志聚合
  onRuntimeEvent: (event) => {
    // 仅打印关键事件以减少日志量
    if (
      event.event === 'handler.completed' ||
      event.event === 'handler.failed' ||
      event.event === 'handler.timed_out' ||
      event.event === 'busy.rejected'
    ) {
      console.info('[RUNTIME]', JSON.stringify(event))
    }
  },

  // 消息分发模式（默认 'serial'：同一会话串行处理）
  // 'parallel'：同一会话允许并发处理；也可传入自定义 Scheduler 对象
  // dispatchMode: 'serial',

  // 自定义会话分组键，默认为群聊 group:<chatId>:user:<userId>，私聊 dm:<userId>
  // conversationKeyResolver: (ctx) => `custom:${ctx.chatId}:${ctx.userId}`,
})

// ===== 2. 中间件：审计日志 =====
// 中间件在 onMessage / onCommand 之前执行，可用来记录日志、鉴权等。
// 通过 AppContext 的 kind 字段区分消息类型：
//   kind === 'event'   → EventContext（进入群聊等事件，可调用 reply()）
//   kind !== 'event'   → MessageContext（用户消息，可调用 reply() / replyStream() / text / msgType）
app.use(async (ctx, next) => {
  const now = new Date().toISOString()

  if (ctx.kind === 'event') {
    console.info(
      '[AUDIT]',
      JSON.stringify({
        ts: now,
        traceId: ctx.traceId,
        kind: ctx.kind,
        chatId: ctx.chatId,
        userId: ctx.userId,
        event: 'enter_chat',
      }),
    )
  } else {
    const text = ctx.text.length > 500 ? `${ctx.text.slice(0, 500)}...(截断)` : ctx.text
    console.info(
      '[AUDIT]',
      JSON.stringify({
        ts: now,
        traceId: ctx.traceId,
        kind: ctx.kind,
        chatId: ctx.chatId,
        userId: ctx.userId,
        msgType: ctx.msgType,
        command: ctx.command?.name,
        text,
      }),
    )
  }

  await next()
})

// ===== 3a. 事件处理器 =====
// 进入群聊等事件由 onEvent 接收，使用 EventContext（无 replyStream）
app.onEvent(async (ctx) => {
  await ctx.reply('你好！发送任意消息开始对话，输入 /help 查看可用命令。')
})

// ===== 3b. 消息处理器 =====
// 处理普通消息。已注册的命令（onCommand）会优先匹配，不会进入此处理器。
// ctx 是 MessageContext，可使用 text / msgType / state / reply / replyStream
app.onMessage(async (ctx) => {
  const count = ((ctx.state.msgCount as number) ?? 0) + 1
  ctx.state.msgCount = count

  console.log(`[MSG] chat=${ctx.chatId} user=${ctx.userId} count=${count} text="${ctx.text}"`)
  await ctx.reply(`收到第 ${count} 条：你说「${ctx.text}」`)
})

// ===== 4. 命令处理器 =====
// 消息以 "/" 开头时自动提取命令名与参数，匹配到已注册命令后调用对应 handler。
// 命令 handler 的类型是 MessageHandler，ctx 为 MessageContext。

// /ping - 连通性测试
app.onCommand('ping', async (ctx) => {
  await ctx.reply('pong')
})

// /help - 显示可用命令
app.onCommand('help', async (ctx) => {
  await ctx.reply(
    [
      '/ping   - 测试连通性',
      '/stream - 流式响应示例',
      '/help   - 显示本帮助',
    ].join('\n'),
  )
})

// /stream - 流式响应：模拟 AI 逐段输出
// replyStream() 返回 ReplyStream 对象，支持 append + end 分段发送，
// 也可调用 error() 中途终止并发送错误消息。
app.onCommand('stream', async (ctx) => {
  const stream = ctx.replyStream()
  const chunks = [
    '这是流式响应示例。',
    '\n第一段：正在处理你的请求...',
    '\n第二段：继续生成内容...',
    '\n第三段：处理完成。',
  ]

  for (const chunk of chunks) {
    stream.append(chunk)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  await stream.end()
})

// ===== 5. 启动与优雅关闭 =====
// start() 会建立 WebSocket 连接并开始接收消息。
// stop() 会断开连接并释放单实例锁。
await app.start()
console.log('AIBot Connect 已启动，按 Ctrl+C 退出')

// 捕获终止信号，确保资源被释放
process.on('SIGINT', async () => {
  console.log('\n正在关闭...')
  await app.stop()
  process.exit(0)
})

process.on('SIGTERM', async () => {
  await app.stop()
  process.exit(0)
})
