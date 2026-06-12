#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  createApp,
  ClaudeCodeCliAgent,
  CodexCliAgent,
  RouterAgent,
} from './index.js'

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  agent?: string
  botId?: string
  secret?: string
  model?: string
}

/** @internal Exposed for unit testing. Not part of the public package API. */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const val = argv[i + 1]
    if (val !== undefined && !val.startsWith('--')) {
      args[key as keyof CliArgs] = val
      i++
    } else {
      ;(args as Record<string, string>)[key] = 'true'
    }
  }
  return args
}

// ---------------------------------------------------------------------------
// .env loader (inlined to avoid extra dependency)
// ---------------------------------------------------------------------------

/** @internal Exposed for unit testing. Not part of the public package API. */
export function loadEnvFile(dir: string): void {
  try {
    const content = readFileSync(join(dir, '.env'), 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const idx = trimmed.indexOf('=')
      if (idx === -1) continue
      const key = trimmed.slice(0, idx).trim()
      const val = trimmed.slice(idx + 1).trim()
      // Only set if not already in env (CLI args take priority)
      if (!process.env[key]) {
        process.env[key] = val
      }
    }
  } catch {
    // .env not found or unreadable — that's fine
  }
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

const HELP = `aibot-connect — 企业微信 AI 机器人一键启动

Usage:
  aibot-connect --agent <claude|codex> [options]

Options:
  --agent     必需。选择 AI Agent：claude（Claude Code）或 codex（Codex）
  --bot-id    企业微信机器人 BotId（优先级高于 .env）
  --secret    企业微信机器人 Secret（优先级高于 .env）
  --model     传递给 Agent 的模型名（如 claude-sonnet-4-6）

凭证可以通过当前目录的 .env 文件提供（推荐），也可通过命令行参数传入。
优先级：命令行参数 > .env 文件。

示例：
  aibot-connect --agent claude
  aibot-connect --agent codex --model gpt-5-codex
  aibot-connect --agent claude --bot-id xxx --secret yyy`

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.agent === 'help' || process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(HELP)
    process.exit(0)
  }

  // 1. Load .env from cwd (lower priority — only sets vars not already present)
  loadEnvFile(process.cwd())

  // 2. CLI args override (higher priority)
  if (args.botId) process.env.WECOM_BOT_ID = args.botId
  if (args.secret) process.env.WECOM_SECRET = args.secret

  // 3. Validate agent choice
  if (!args.agent || !['claude', 'codex'].includes(args.agent)) {
    console.error('错误：需要指定 --agent claude 或 --agent codex')
    console.error('使用 --help 查看完整帮助')
    process.exit(2)
  }

  const cwd = process.cwd()
  const model = args.model

  // 4. Create agent
  const agent = args.agent === 'codex'
    ? new CodexCliAgent({ cwd, ...(model ? { model } : {}) })
    : new ClaudeCodeCliAgent({ cwd, ...(model ? { model } : {}) })

  // 5. Wrap in RouterAgent (gives /reset, /stop, /status, /help for free)
  const router = new RouterAgent({
    agents: { [args.agent]: agent },
    defaultAgent: args.agent,
    displayName: args.agent === 'codex' ? 'Codex 助手' : 'Claude 助手',
  })

  // 6. Create app and wire up
  const app = createApp()

  app.onMessage(async (ctx) => {
    await router.handle(ctx)
  })

  app.onEvent(async (ctx) => {
    await router.handleEvent(ctx)
  })

  // 7. Start
  await app.start()
  console.log(`[aibot-connect] 已启动 — agent=${args.agent} cwd=${cwd}`)

  // 8. Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`\n[aibot-connect] 收到 ${signal}，正在关闭...`)
    await app.stop()
    process.exit(0)
  }

  process.on('SIGINT', () => { void shutdown('SIGINT') })
  process.on('SIGTERM', () => { void shutdown('SIGTERM') })
}


const isMain = !process.env.VITEST
if (isMain) {
main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  console.error(`[aibot-connect] 致命错误：${message}`)
  process.exit(1)
})

} else {
  // imported for testing — suppress top-level main
}
