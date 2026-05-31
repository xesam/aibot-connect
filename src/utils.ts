import type { ReplyStreamState } from './types.js'

export function toError(error: unknown): Error {
  if (error instanceof Error) return error
  if (typeof error === 'string') return new Error(error)
  if (error && typeof error === 'object') {
    const maybeMessage = (error as { message?: unknown }).message
    if (typeof maybeMessage === 'string' && maybeMessage.length > 0) {
      return new Error(maybeMessage)
    }
    try {
      return new Error(JSON.stringify(error))
    } catch {
      return new Error(String(error))
    }
  }
  return new Error(String(error))
}

export function toErrorMessage(error: unknown): string {
  return toError(error).message
}

export function isTerminalState(state: ReplyStreamState): boolean {
  return state === 'ended' || state === 'failed'
}
