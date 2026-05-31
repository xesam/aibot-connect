import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { AgentMessage, AgentStream } from './types.js'
import type { Logger } from '../logger.js'
import { toErrorMessage } from '../utils.js'

const STDERR_MAX_BYTES = 1_000_000 // 1 MB
export const SIGTERM_GRACE_MS = 3_000

export interface CliAgentOptions {
  command: string
  args: string[]
  cwd: string
  stdin: string
  abortController?: AbortController
  /**
   * Optional logger for diagnostic output. Currently unused by runCliAgent itself
   * (errors are surfaced via the AgentStream as `{ type: 'error' }`), but accepted
   * for symmetry with other subsystems and future use.
   */
  logger?: Logger
  parseLine(line: string): AgentMessage | AgentMessage[] | null
}

export async function* runCliAgent(opts: CliAgentOptions): AgentStream {
  const { command, args, cwd, stdin, abortController, parseLine } = opts

  const stderrChunks: Buffer[] = []
  let stderrBytes = 0
  let stderrTruncated = false

  const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })

  // Capture spawn-time errors (ENOENT for missing binary, EACCES, EPIPE, etc.)
  // Must register synchronously before the error event can fire.
  let spawnError: Error | null = null
  child.on('error', (err) => {
    spawnError = err
  })

  child.stderr!.on('data', (chunk: Buffer) => {
    if (stderrBytes >= STDERR_MAX_BYTES) {
      stderrTruncated = true
      return
    }
    const remaining = STDERR_MAX_BYTES - stderrBytes
    if (chunk.length > remaining) {
      stderrChunks.push(chunk.subarray(0, remaining))
      stderrBytes = STDERR_MAX_BYTES
      stderrTruncated = true
    } else {
      stderrChunks.push(chunk)
      stderrBytes += chunk.length
    }
  })

  // Defensive: ignore EPIPE on stdin if child has already exited
  child.stdin!.on('error', () => {})

  let processExited = false
  const exitPromise = new Promise<number | null>((resolve) => {
    child.on('close', (code) => {
      processExited = true
      resolve(code)
    })
  })

  const killTree = (): void => {
    if (processExited || child.exitCode !== null || child.signalCode !== null) return
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    const t = setTimeout(() => {
      if (processExited || child.exitCode !== null || child.signalCode !== null) return
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }, SIGTERM_GRACE_MS)
    t.unref()
    child.once('exit', () => clearTimeout(t))
  }

  const onAbort = (): void => {
    killTree()
  }
  if (abortController) {
    abortController.signal.addEventListener('abort', onAbort)
  }

  try {
    child.stdin!.write(stdin)
    child.stdin!.end()
  } catch {
    // stdin already closed; child.on('error') will surface the cause
  }

  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity })

  try {
    for await (const line of rl) {
      if (!line.trim()) continue

      const result = parseLine(line)
      if (result === null) continue
      if (Array.isArray(result)) {
        for (const msg of result) yield msg
      } else {
        yield result
      }
    }

    const exitCode = await exitPromise

    if (spawnError) {
      yield { type: 'error', message: toErrorMessage(spawnError) }
    } else if (exitCode !== 0 && exitCode !== null) {
      if (abortController?.signal.aborted) {
        yield { type: 'done' }
      } else {
        const stderr = Buffer.concat(stderrChunks).toString('utf-8').trim()
        const suffix = stderrTruncated ? '\n[stderr truncated]' : ''
        yield { type: 'error', message: (stderr || `${command} exited with code ${exitCode}`) + suffix }
      }
    } else {
      yield { type: 'done' }
    }
  } catch (error) {
    yield { type: 'error', message: toErrorMessage(error) }
  } finally {
    if (abortController) {
      abortController.signal.removeEventListener('abort', onAbort)
    }
    rl.close()
    killTree()
  }
}
