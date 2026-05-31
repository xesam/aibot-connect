import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { setLogLevel, log, createLogger } from '../../src/logger.js'

describe('logger', () => {
  beforeEach(() => {
    setLogLevel('info')
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('info level logs info messages', () => {
    log.info('test message')
    expect(console.info).toHaveBeenCalled()
  })

  it('info level suppresses debug messages', () => {
    log.debug('debug message')
    expect(console.log).not.toHaveBeenCalled()
  })

  it('silent level suppresses all messages', () => {
    setLogLevel('silent')
    log.info('test')
    log.warn('test')
    log.error('test')
    expect(console.info).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
    expect(console.error).not.toHaveBeenCalled()
  })

  it('invalid level is ignored', () => {
    setLogLevel('invalid')
    log.info('test')
    expect(console.info).toHaveBeenCalled()
  })
})

describe('createLogger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => vi.restoreAllMocks())

  it('isolated logger respects its own level (debug logger emits debug, info logger does not)', () => {
    const logA = createLogger({ level: 'debug' })
    const logB = createLogger({ level: 'info' })

    logA.debug('A')
    logB.debug('B')

    expect(console.log).toHaveBeenCalledTimes(1)
    expect((console.log as any).mock.calls[0].join(' ')).toContain('A')
  })

  it('createLogger does not share state with setLogLevel global', () => {
    setLogLevel('silent')
    try {
      const isolated = createLogger({ level: 'info' })
      isolated.info('isolated info')
      expect(console.info).toHaveBeenCalledTimes(1)
    } finally {
      setLogLevel('info')
    }
  })

  it('createLogger defaults to info level when no option given', () => {
    const lg = createLogger()
    lg.debug('hidden')
    lg.info('shown')
    expect(console.log).not.toHaveBeenCalled()
    expect(console.info).toHaveBeenCalledTimes(1)
  })
})
