import { describe, it, expect } from 'vitest'
import { toError, toErrorMessage, isTerminalState } from '../../src/utils.js'

describe('toError', () => {
  it('returns the same Error instance if already an Error', () => {
    const err = new Error('test')
    expect(toError(err)).toBe(err)
  })

  it('wraps a string into an Error', () => {
    const err = toError('something broke')
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('something broke')
  })

  it('extracts message property from an object', () => {
    const err = toError({ message: 'custom message' })
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('custom message')
  })

  it('JSON-stringifies an object without a message property', () => {
    const err = toError({ code: 500 })
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('{"code":500}')
  })

  it('handles non-serializable objects gracefully', () => {
    const obj: Record<string, unknown> = {}
    obj['self'] = obj // circular
    const err = toError(obj)
    expect(err).toBeInstanceOf(Error)
  })

  it('handles null and undefined', () => {
    expect(toError(null).message).toBe('null')
    expect(toError(undefined).message).toBe('undefined')
  })

  it('handles numbers', () => {
    expect(toError(42).message).toBe('42')
  })
})

describe('toErrorMessage', () => {
  it('returns Error.message directly', () => {
    expect(toErrorMessage(new Error('boom'))).toBe('boom')
  })

  it('returns string as-is', () => {
    expect(toErrorMessage('boom')).toBe('boom')
  })
})

describe('isTerminalState', () => {
  it('returns true for ended and failed', () => {
    expect(isTerminalState('ended')).toBe(true)
    expect(isTerminalState('failed')).toBe(true)
  })

  it('returns false for idle and streaming', () => {
    expect(isTerminalState('idle')).toBe(false)
    expect(isTerminalState('streaming')).toBe(false)
  })
})
