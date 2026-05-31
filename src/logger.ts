export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

const LEVEL_NAMES: Record<string, LogLevel> = {
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
  silent: LogLevel.SILENT,
}

export interface Logger {
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

function parseLevel(level: string | LogLevel | undefined, fallback: LogLevel): LogLevel {
  if (level === undefined) return fallback
  if (typeof level === 'number') return level
  return LEVEL_NAMES[level.toLowerCase()] ?? fallback
}

function timestamp(): string {
  const d = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export interface CreateLoggerOptions {
  level?: string | LogLevel
}

/**
 * Create a Logger instance with a fixed level (captured at creation time).
 * Pass to subsystem constructors to isolate log output across multiple
 * App instances. Not affected by `setLogLevel`.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const level = parseLevel(options.level, LogLevel.INFO)
  return {
    debug(...args: unknown[]): void {
      if (LogLevel.DEBUG >= level) console.log(`[${timestamp()}] [DEBUG]`, ...args)
    },
    info(...args: unknown[]): void {
      if (LogLevel.INFO >= level) console.info(`[${timestamp()}] [INFO]`, ...args)
    },
    warn(...args: unknown[]): void {
      if (LogLevel.WARN >= level) console.warn(`[${timestamp()}] [WARN]`, ...args)
    },
    error(...args: unknown[]): void {
      if (LogLevel.ERROR >= level) console.error(`[${timestamp()}] [ERROR]`, ...args)
    },
  }
}

// ----- Backward-compatible global -----

let defaultLevel: LogLevel = LogLevel.INFO

/**
 * Set the log level for the global `log` singleton only.
 *
 * **Note:** Loggers created via `createLogger()` capture their own level at
 * creation time and are NOT affected by this call. Inside `createApp(...)`,
 * a per-instance logger is created and injected into all subsystems —
 * `setLogLevel` will not change verbosity for an already-running app.
 * Pass `logLevel` to `createApp(options)` instead.
 */
export function setLogLevel(level: string | LogLevel | undefined): void {
  if (level === undefined) return
  if (typeof level === 'number') {
    defaultLevel = level
    return
  }
  const resolved = LEVEL_NAMES[level.toLowerCase()]
  if (resolved !== undefined) defaultLevel = resolved
}

/**
 * Global default logger backed by `setLogLevel`. Used as fallback when no
 * Logger is injected; `createApp` does not route through this.
 */
export const log: Logger = {
  debug(...args: unknown[]): void {
    if (LogLevel.DEBUG >= defaultLevel) console.log(`[${timestamp()}] [DEBUG]`, ...args)
  },
  info(...args: unknown[]): void {
    if (LogLevel.INFO >= defaultLevel) console.info(`[${timestamp()}] [INFO]`, ...args)
  },
  warn(...args: unknown[]): void {
    if (LogLevel.WARN >= defaultLevel) console.warn(`[${timestamp()}] [WARN]`, ...args)
  },
  error(...args: unknown[]): void {
    if (LogLevel.ERROR >= defaultLevel) console.error(`[${timestamp()}] [ERROR]`, ...args)
  },
}
