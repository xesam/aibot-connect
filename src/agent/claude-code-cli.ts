import { log } from '../logger.js'
import type { Agent, AgentOptions, AgentMessage, AgentStream, ClaudeCodeCliConfig } from './types.js'
import { runCliAgent } from './cli-utils.js'

export function parseClaudeStreamLine(line: string): AgentMessage[] | null {
  const messages: AgentMessage[] = []

  try {
    const msg = JSON.parse(line)

    switch (msg.type) {
      case 'system':
        if (msg.subtype === 'init' && msg.session_id) {
          // Emit early so aborted streams still capture a resumable session id.
          // The result/success handler below emits the final authoritative id.
          messages.push({ type: 'session', sessionId: msg.session_id })
        }
        break

      case 'assistant':
        if (msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              messages.push({ type: 'text', text: block.text })
            }
            if (block.type === 'tool_use') {
              messages.push({
                type: 'tool_call',
                toolName: block.name,
                input: block.input ?? {},
              })
            }
          }
        }
        break

      case 'result':
        if (msg.subtype === 'success') {
          if (msg.session_id) {
            messages.push({ type: 'session', sessionId: msg.session_id })
          }
          messages.push({
            type: 'done',
            costUsd: msg.total_cost_usd,
            usage: {
              inputTokens: msg.usage?.input_tokens ?? 0,
              outputTokens: msg.usage?.output_tokens ?? 0,
            },
          })
        } else {
          const errorMsg = msg.errors?.join('; ') ?? msg.subtype
          messages.push({ type: 'error', message: errorMsg })
        }
        break
    }
  } catch {
    if (line.trim()) {
      messages.push({ type: 'text', text: line })
    }
  }

  return messages.length > 0 ? messages : null
}

export class ClaudeCodeCliAgent implements Agent {
  readonly name = 'claude-code-cli'
  private config: ClaudeCodeCliConfig

  constructor(config: ClaudeCodeCliConfig) {
    this.config = config
  }

  async *query(prompt: string, options: AgentOptions): AgentStream {
    const args = ['--print', '--output-format', 'stream-json', '--verbose']

    if (options.resume) {
      args.push('--resume', options.resume)
    }
    if (this.config.model) {
      args.push('--model', this.config.model)
    }
    if (this.config.allowedTools?.length) {
      args.push('--allowedTools', this.config.allowedTools.join(','))
    }
    if (this.config.maxTurns) {
      args.push('--max-turns', String(this.config.maxTurns))
    }

    args.push('--permission-mode', 'acceptEdits')

    log.debug(`[ClaudeCodeCli] Spawning: claude ${args.join(' ')}`)

    yield* runCliAgent({
      command: 'claude',
      args,
      cwd: options.cwd ?? this.config.cwd,
      stdin: prompt,
      abortController: options.abortController,
      parseLine: parseClaudeStreamLine,
    })
  }
}
