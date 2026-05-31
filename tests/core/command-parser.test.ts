import { describe, it, expect } from 'vitest'
import { parseCommand } from '../../src/core/command-parser.js'

describe('parseCommand', () => {
  it('recognizes /reset command', () => {
    const result = parseCommand('/reset')
    expect(result.isCommand).toBe(true)
    expect(result.command).toBe('reset')
  })

  it('recognizes /help command', () => {
    const result = parseCommand('/help')
    expect(result.isCommand).toBe(true)
    expect(result.command).toBe('help')
  })

  it('is case-insensitive', () => {
    const result = parseCommand('/RESET')
    expect(result.isCommand).toBe(true)
    expect(result.command).toBe('reset')
  })

  it('ignores non-command text', () => {
    const result = parseCommand('hello world')
    expect(result.isCommand).toBe(false)
    expect(result.command).toBeUndefined()
  })

  it('returns unknown command name for unregistered commands', () => {
    const result = parseCommand('/unknown')
    expect(result.isCommand).toBe(true)
    expect(result.command).toBe('unknown')
  })

  it('extracts args after command', () => {
    const result = parseCommand('/reset force')
    expect(result.isCommand).toBe(true)
    expect(result.command).toBe('reset')
    expect(result.args).toBe('force')
  })

  it('handles leading whitespace', () => {
    const result = parseCommand('  /reset  ')
    expect(result.isCommand).toBe(true)
    expect(result.command).toBe('reset')
  })

  it('supports mention prefix before command', () => {
    const result = parseCommand('@机器人 /stream 流测试')
    expect(result.isCommand).toBe(true)
    expect(result.command).toBe('stream')
    expect(result.args).toBe('流测试')
  })

  it('supports full-width mention prefix before command', () => {
    const result = parseCommand('＠机器人 /ping')
    expect(result.isCommand).toBe(true)
    expect(result.command).toBe('ping')
  })

  it('supports multiple leading mentions before command', () => {
    const result = parseCommand('@机器人 @助手 /help')
    expect(result.isCommand).toBe(true)
    expect(result.command).toBe('help')
  })
})
