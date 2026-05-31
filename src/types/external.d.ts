// 声明可选依赖的类型，避免未安装时 tsc 报错

declare module '@anthropic-ai/claude-agent-sdk' {
  interface SdkContentBlock {
    type: string
    text?: string
    name?: string
    input?: Record<string, unknown>
  }

  interface SdkAssistantMessage {
    type: 'assistant'
    message?: {
      id?: string
      type?: string
      role?: string
      model?: string
      content?: SdkContentBlock[]
      stop_reason?: string | null
      stop_sequence?: string | null
      usage?: SdkUsage
    }
    parent_tool_use_id?: string | null
    session_id?: string
  }

  interface SdkSystemMessage {
    type: 'system'
    subtype: string
    session_id?: string
    cwd?: string
    tools?: string[]
    model?: string
    permissionMode?: string
    uuid?: string
  }

  interface SdkResultMessage {
    type: 'result'
    subtype: string
    is_error?: boolean
    session_id?: string
    total_cost_usd?: number
    usage?: SdkUsage
    errors?: string[]
    stop_reason?: string
    result?: string
    duration_ms?: number
    num_turns?: number
  }

  interface SdkUsage {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
    service_tier?: string
  }

  type SdkMessage = SdkSystemMessage | SdkAssistantMessage | SdkResultMessage

  export function query(input: {
    prompt: string
    options?: Record<string, unknown>
  }): AsyncIterable<SdkMessage>
}
