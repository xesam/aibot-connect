import { log } from '../logger.js'
import { toErrorMessage } from '../utils.js'
import type { Agent, AgentOptions, AgentStream, ClaudeCodeSdkConfig } from './types.js'

export class ClaudeCodeSdkAgent implements Agent {
  readonly name = 'claude-code-sdk'
  private config: ClaudeCodeSdkConfig

  constructor(config: ClaudeCodeSdkConfig) {
    this.config = config
  }

  async *query(prompt: string, options: AgentOptions): AgentStream {
    let sdk: typeof import('@anthropic-ai/claude-agent-sdk')
    try {
      sdk = await import('@anthropic-ai/claude-agent-sdk')
    } catch {
      yield { type: 'error', message: '@anthropic-ai/claude-agent-sdk not installed. Run: npm install @anthropic-ai/claude-agent-sdk' }
      return
    }

    const sdkOptions: Record<string, unknown> = {
      model: this.config.model,
      cwd: options.cwd ?? this.config.cwd,
      allowedTools: this.config.allowedTools ?? ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'],
      maxTurns: this.config.maxTurns ?? 50,
      maxBudgetUsd: this.config.maxBudgetUsd ?? 5.0,
      permissionMode: 'acceptEdits',
    }

    if (options.resume) {
      sdkOptions.resume = options.resume
    }

    let innerController: AbortController | undefined
    let onAbort: (() => void) | undefined
    if (options.abortController) {
      innerController = new AbortController()
      sdkOptions.abortController = innerController
      onAbort = (): void => { innerController!.abort() }
      options.abortController.signal.addEventListener('abort', onAbort)
    }

    try {
      const messageStream = sdk.query({ prompt, options: sdkOptions })

      for await (const message of messageStream) {
        if (message.type === 'system' && message.subtype === 'init') {
          if (message.session_id) {
            // Emit early so aborted streams still capture a resumable session id.
            // The result/success handler below emits the final authoritative id.
            yield { type: 'session', sessionId: message.session_id }
          }
          continue
        }

        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if (block.type === 'text' && block.text) {
              yield { type: 'text', text: block.text }
            }
            if (block.type === 'tool_use' && block.name) {
              yield {
                type: 'tool_call',
                toolName: block.name,
                input: block.input ?? {},
              }
            }
          }
          continue
        }

        if (message.type === 'result') {
          if (message.subtype === 'success') {
            if (message.session_id) {
              yield { type: 'session', sessionId: message.session_id }
            }
            yield {
              type: 'done',
              costUsd: message.total_cost_usd,
              usage: {
                inputTokens: message.usage?.input_tokens ?? 0,
                outputTokens: message.usage?.output_tokens ?? 0,
              },
            }
          } else {
            const errorMsg = message.errors?.join('; ') ?? message.subtype
            yield { type: 'error', message: errorMsg }
          }
        }
      }
    } catch (error) {
      log.error(`[ClaudeCodeSdk] Query error: ${toErrorMessage(error)}`)
      yield { type: 'error', message: toErrorMessage(error) }
    } finally {
      if (onAbort && options.abortController) {
        options.abortController.signal.removeEventListener('abort', onAbort)
      }
    }
  }
}
