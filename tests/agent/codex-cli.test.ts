import { describe, it, expect, vi } from 'vitest'
import { parseCodexStreamLine, CodexCliAgent } from '../../src/agent/codex-cli.js'

// ============================================================
// Mock for runCliAgent — captures call opts so tests can
// assert on the exact args array without spawning a real process.
// vi.mock is hoisted; the captured variable is initialised via vi.hoisted.
// ============================================================

const { capturedOpts } = vi.hoisted(() => ({
  capturedOpts: { args: [] as string[] },
}))

vi.mock('../../src/agent/cli-utils.js', () => ({
  runCliAgent: vi.fn(async function* (opts: { args: string[] }) {
    capturedOpts.args = opts.args
    // Yield nothing — tests only care about args, not streamed messages.
  }),
}))

describe('parseCodexStreamLine', () => {
  // ---- codex --json 新格式 ----

  it('parses thread.started → session message', () => {
    const result = parseCodexStreamLine(
      JSON.stringify({ type: 'thread.started', thread_id: 'thr-001' })
    )
    expect(result).toEqual({ type: 'session', sessionId: 'thr-001' })
  })

  it('skips thread.started without thread_id', () => {
    const result = parseCodexStreamLine(
      JSON.stringify({ type: 'thread.started' })
    )
    expect(result).toBeNull()
  })

  it('parses item.completed agent_message → text message', () => {
    const result = parseCodexStreamLine(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_1', type: 'agent_message', text: 'Hello' },
      })
    )
    expect(result).toEqual({ type: 'text', text: 'Hello' })
  })

  it('skips item.completed reasoning messages', () => {
    const result = parseCodexStreamLine(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_0', type: 'reasoning', text: 'thinking...' },
      })
    )
    expect(result).toBeNull()
  })

  it('skips item.completed agent_message without text', () => {
    const result = parseCodexStreamLine(
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'item_1', type: 'agent_message' },
      })
    )
    expect(result).toBeNull()
  })

  it('parses turn.completed → done with usage', () => {
    const result = parseCodexStreamLine(
      JSON.stringify({
        type: 'turn.completed',
        usage: { input_tokens: 100, output_tokens: 50 },
      })
    )
    expect(result).toEqual({
      type: 'done',
      usage: { inputTokens: 100, outputTokens: 50 },
    })
  })

  it('parses turn.completed without usage → done with no usage field', () => {
    const result = parseCodexStreamLine(
      JSON.stringify({ type: 'turn.completed' })
    )
    expect(result).toEqual({ type: 'done' })
  })

  it('returns null for turn.started (ignored)', () => {
    const result = parseCodexStreamLine(
      JSON.stringify({ type: 'turn.started' })
    )
    expect(result).toBeNull()
  })

  // ---- 兼容旧格式 ----

  it('parses legacy session format', () => {
    const result = parseCodexStreamLine(
      JSON.stringify({ type: 'session', session_id: 'sess-old' })
    )
    expect(result).toEqual({ type: 'session', sessionId: 'sess-old' })
  })

  it('parses legacy assistant with string content', () => {
    const result = parseCodexStreamLine(
      JSON.stringify({ type: 'assistant', content: 'Hi' })
    )
    expect(result).toEqual({ type: 'text', text: 'Hi' })
  })

  it('parses legacy assistant with object content', () => {
    const result = parseCodexStreamLine(
      JSON.stringify({ type: 'assistant', content: { text: 'Hi' } })
    )
    expect(result).toEqual({ type: 'text', text: 'Hi' })
  })

  it('parses legacy plain text type', () => {
    const result = parseCodexStreamLine(
      JSON.stringify({ type: 'text', text: 'Hello' })
    )
    expect(result).toEqual({ type: 'text', text: 'Hello' })
  })

  // ---- 边界情况 ----

  it('falls back to plain text for non-JSON lines', () => {
    const result = parseCodexStreamLine('just some text')
    expect(result).toEqual({ type: 'text', text: 'just some text' })
  })

  it('returns null for unrecognized JSON type', () => {
    const result = parseCodexStreamLine(
      JSON.stringify({ type: 'unknown', data: 'x' })
    )
    expect(result).toBeNull()
  })
})

// ============================================================
// Args structure regression tests
// ============================================================

describe('CodexCliAgent query args structure', () => {
  async function drainStream(stream: AsyncIterable<unknown>): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _ of stream) { /* drain */ }
  }

  it('new session: args are ["exec", "--json"]', async () => {
    const agent = new CodexCliAgent({ cwd: '/tmp' })
    await drainStream(agent.query('hello', {}))
    expect(capturedOpts.args).toEqual(['exec', '--json', '--skip-git-repo-check'])
  })

  it('new session with model: args include --model after --json', async () => {
    const agent = new CodexCliAgent({ cwd: '/tmp', model: 'gpt-4o' })
    await drainStream(agent.query('hello', {}))
    expect(capturedOpts.args).toEqual(['exec', '--json', '--skip-git-repo-check', '--model', 'gpt-4o'])
  })

  it('resume session: args are ["exec", "resume", "<id>", "<prompt>", "--json", "--skip-git-repo-check"]', async () => {
    const agent = new CodexCliAgent({ cwd: '/tmp' })
    await drainStream(agent.query('follow-up', { resume: 'sess-abc123' }))
    expect(capturedOpts.args).toEqual(['exec', 'resume', 'sess-abc123', 'follow-up', '--json', '--skip-git-repo-check'])
  })
})
