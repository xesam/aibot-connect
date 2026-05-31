import { log } from '../logger.js'
import type { Agent, AgentOptions, AgentMessage, AgentStream, CodexCliConfig } from './types.js'
import { runCliAgent } from './cli-utils.js'

export function parseCodexStreamLine(line: string): AgentMessage | null {
  try {
    const msg = JSON.parse(line)

    // codex --json 格式:
    //   {"type":"thread.started","thread_id":"..."}
    //   {"type":"item.completed","item":{"id":"...","type":"agent_message","text":"Hi"}}
    //   {"type":"turn.completed","usage":{...}}

    if (msg.type === 'thread.started' && msg.thread_id) {
      return { type: 'session', sessionId: msg.thread_id }
    }

    if (msg.type === 'turn.completed') {
      return {
        type: 'done',
        ...(msg.usage && {
          usage: {
            inputTokens: msg.usage.input_tokens ?? 0,
            outputTokens: msg.usage.output_tokens ?? 0,
          },
        }),
      }
    }

    if (msg.type === 'item.completed' && msg.item) {
      if (msg.item.type === 'agent_message' && msg.item.text) {
        return { type: 'text', text: msg.item.text }
      }
    }

    // 兼容旧格式（session / assistant / text）
    if (msg.type === 'session' && msg.session_id) {
      return { type: 'session', sessionId: msg.session_id }
    }

    if (msg.type === 'assistant' && msg.content) {
      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content.text ?? ''
      if (text) return { type: 'text', text }
    }

    if (msg.type === 'text' && msg.text) {
      return { type: 'text', text: msg.text }
    }

    return null
  } catch {
    return { type: 'text', text: line }
  }
}

export class CodexCliAgent implements Agent {
  readonly name = 'codex-cli'
  private config: CodexCliConfig

  constructor(config: CodexCliConfig) {
    this.config = config
  }

  async *query(prompt: string, options: AgentOptions): AgentStream {
    const args = options.resume ? ['resume', options.resume, '-'] : ['exec']

    args.push('--json')

    if (this.config.model) {
      args.push('--model', this.config.model)
    }

    log.debug(`[CodexCli] Spawning: codex ${args.join(' ')}`)

    yield* runCliAgent({
      command: 'codex',
      args,
      cwd: options.cwd ?? this.config.cwd,
      stdin: prompt,
      abortController: options.abortController,
      parseLine: parseCodexStreamLine,
    })
  }
}
