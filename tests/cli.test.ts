import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs, loadEnvFile } from '../src/cli.js'

describe('parseArgs', () => {
  it('parses --agent claude', () => {
    expect(parseArgs(['--agent', 'claude'])).toEqual({ agent: 'claude' })
  })

  it('parses --agent codex', () => {
    expect(parseArgs(['--agent', 'codex'])).toEqual({ agent: 'codex' })
  })

  it('parses --bot-id and --secret', () => {
    expect(parseArgs(['--bot-id', 'my-bot', '--secret', 's3cret'])).toEqual({
      'bot-id': 'my-bot',
      secret: 's3cret',
    })
  })

  it('parses --model', () => {
    expect(parseArgs(['--model', 'claude-opus-4-6'])).toEqual({ model: 'claude-opus-4-6' })
  })

  it('parses combined flags', () => {
    expect(parseArgs(['--agent', 'codex', '--bot-id', 'b1', '--secret', 's1', '--model', 'gpt-5'])).toEqual({
      agent: 'codex',
      'bot-id': 'b1',
      secret: 's1',
      model: 'gpt-5',
    })
  })

  it('treats flag without value as "true"', () => {
    expect(parseArgs(['--verbose'])).toEqual({ verbose: 'true' })
  })

  it('skips non-flag arguments', () => {
    expect(parseArgs(['--agent', 'claude', 'positional'])).toEqual({ agent: 'claude' })
  })

  it('returns empty object for empty argv', () => {
    expect(parseArgs([])).toEqual({})
  })
})

describe('loadEnvFile', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `aibot-cli-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* clean */ }
  })

  it('loads KEY=VALUE pairs into process.env', () => {
    writeFileSync(join(tmpDir, '.env'), 'WECOM_BOT_ID=my-bot\nWECOM_SECRET=my-secret\n')
    delete process.env.WECOM_BOT_ID
    delete process.env.WECOM_SECRET

    loadEnvFile(tmpDir)

    expect(process.env.WECOM_BOT_ID).toBe('my-bot')
    expect(process.env.WECOM_SECRET).toBe('my-secret')
  })

  it('skips comments and blank lines', () => {
    writeFileSync(join(tmpDir, '.env'), '# comment\n\nWECOM_BOT_ID=my-bot\n# another\n\nWECOM_SECRET=my-secret\n')
    delete process.env.WECOM_BOT_ID
    delete process.env.WECOM_SECRET

    loadEnvFile(tmpDir)

    expect(process.env.WECOM_BOT_ID).toBe('my-bot')
    expect(process.env.WECOM_SECRET).toBe('my-secret')
  })

  it('does not overwrite existing env vars', () => {
    writeFileSync(join(tmpDir, '.env'), 'WECOM_BOT_ID=from-env-file\n')
    process.env.WECOM_BOT_ID = 'from-cli-arg'

    loadEnvFile(tmpDir)

    expect(process.env.WECOM_BOT_ID).toBe('from-cli-arg')
  })

  it('sets unset keys while leaving set keys intact', () => {
    writeFileSync(join(tmpDir, '.env'), 'WECOM_BOT_ID=from-env\nWECOM_SECRET=from-env\n')
    process.env.WECOM_BOT_ID = 'from-cli'
    delete process.env.WECOM_SECRET

    loadEnvFile(tmpDir)

    expect(process.env.WECOM_BOT_ID).toBe('from-cli')
    expect(process.env.WECOM_SECRET).toBe('from-env')
  })

  it('does not crash when .env does not exist', () => {
    expect(() => loadEnvFile(tmpDir)).not.toThrow()
  })

  it('handles values with = signs', () => {
    writeFileSync(join(tmpDir, '.env'), 'TOKEN=foo=bar=baz\n')
    delete process.env.TOKEN

    loadEnvFile(tmpDir)

    expect(process.env.TOKEN).toBe('foo=bar=baz')
  })
})

describe('CLI help and validation', () => {
  it('detects --agent help as a help request', () => {
    expect(parseArgs(['--agent', 'help']).agent).toBe('help')
  })

  it('detects missing --agent', () => {
    expect(parseArgs([]).agent).toBeUndefined()
  })

  it('detects invalid --agent value', () => {
    expect(parseArgs(['--agent', 'gpt']).agent).toBe('gpt')
  })

  it('rejects --agent with empty value when next token is a flag', () => {
    const args = parseArgs(['--agent', '--bot-id', 'x'])
    expect(args.agent).toBe('true')
    expect(args['bot-id']).toBe('x')
  })
})
