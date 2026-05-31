import { describe, it, expect } from 'vitest'
import { parseClaudeStreamLine } from '../../src/agent/claude-code-cli.js'

describe('parseClaudeStreamLine', () => {
  it('parses system/init → session message', () => {
    const result = parseClaudeStreamLine(
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-001' })
    )
    expect(result).toEqual([{ type: 'session', sessionId: 'sess-001' }])
  })

  it('skips system/init without session_id', () => {
    const result = parseClaudeStreamLine(
      JSON.stringify({ type: 'system', subtype: 'init' })
    )
    expect(result).toBeNull()
  })

  it('parses assistant/text block → text message', () => {
    const result = parseClaudeStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello!' }] },
      })
    )
    expect(result).toEqual([{ type: 'text', text: 'Hello!' }])
  })

  it('parses assistant/tool_use block → tool_call message', () => {
    const result = parseClaudeStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Read', input: { path: '/f' } }],
        },
      })
    )
    expect(result).toEqual([
      { type: 'tool_call', toolName: 'Read', input: { path: '/f' } },
    ])
  })

  it('parses multiple content blocks in one assistant message', () => {
    const result = parseClaudeStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Let me read...' },
            { type: 'tool_use', name: 'Read', input: { path: '/f' } },
          ],
        },
      })
    )
    expect(result).toEqual([
      { type: 'text', text: 'Let me read...' },
      { type: 'tool_call', toolName: 'Read', input: { path: '/f' } },
    ])
  })

  it('parses result/success → session + done messages', () => {
    const result = parseClaudeStreamLine(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        session_id: 'sess-002',
        total_cost_usd: 0.05,
        usage: { input_tokens: 100, output_tokens: 50 },
      })
    )
    expect(result).toEqual([
      { type: 'session', sessionId: 'sess-002' },
      {
        type: 'done',
        costUsd: 0.05,
        usage: { inputTokens: 100, outputTokens: 50 },
      },
    ])
  })

  it('parses result/error → error message', () => {
    const result = parseClaudeStreamLine(
      JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        errors: ['Max turns exceeded'],
      })
    )
    expect(result).toEqual([{ type: 'error', message: 'Max turns exceeded' }])
  })

  it('returns null for empty assistant content', () => {
    const result = parseClaudeStreamLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [] },
      })
    )
    expect(result).toBeNull()
  })

  it('falls back to plain text for non-JSON lines', () => {
    const result = parseClaudeStreamLine('plain text output')
    expect(result).toEqual([{ type: 'text', text: 'plain text output' }])
  })

  it('returns null for empty line', () => {
    const result = parseClaudeStreamLine('')
    expect(result).toBeNull()
  })
})
