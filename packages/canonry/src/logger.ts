/**
 * Structured logger for machine-readable and agent-friendly log output.
 *
 * - Non-TTY (CI, piped, agent): JSON lines with standard fields
 * - TTY (human dev): compact colored text with key context inline
 *
 * ## Standard fields (every entry)
 *
 *   ts       — ISO 8601 timestamp
 *   level    — info | warn | error
 *   module   — logical subsystem (e.g. "JobRunner", "Scheduler")
 *   action   — machine-grepable label (see convention below)
 *   ...ctx   — arbitrary key-value context (url, runId, provider, status, etc.)
 *
 * ## Action naming convention
 *
 * Actions use `noun.verb` or `noun.verb-detail` format. This is a convention,
 * not an enum — adding a new log line should never require editing a central
 * file. Follow these rules when choosing an action string:
 *
 *   Pattern:       <subject>.<verb>[-<detail>]
 *   Subject:       the thing being acted on (run, query, webhook, sync, cron, ...)
 *   Verb:          what happened (start, complete, fail, skip, ok, ...)
 *   Detail suffix: optional disambiguator (-stale, -batch, -url, ...)
 *
 *   Examples:
 *     run.dispatch          — a run is being dispatched to providers
 *     query.failed          — a single provider query failed
 *     index-submit.ok       — a Bing indexing submission succeeded
 *     index-submit.failed   — a Bing indexing submission failed
 *     webhook.attempt-failed — a webhook delivery attempt failed (will retry)
 *     http.error            — an HTTP client received a non-2xx response
 *
 * ## Common context keys (prefer these names for consistency)
 *
 *   runId, projectId, provider, keyword   — identifiers
 *   url, sitemapUrl, domain               — URLs / domains
 *   httpStatus, responseBody              — HTTP response details
 *   error, stack                          — error diagnostics
 *   count, total, progress                — numeric progress
 */

const IS_TTY = process.stdout.isTTY === true

type LogLevel = 'info' | 'warn' | 'error'

interface LogEntry {
  ts: string
  level: LogLevel
  module: string
  action: string
  msg?: string
  [key: string]: unknown
}

function formatTTY(entry: LogEntry): string {
  const { ts, level, module, action, msg, ...ctx } = entry
  const time = ts.slice(11, 19) // HH:MM:SS
  const levelTag = level === 'error' ? '\x1b[31mERR\x1b[0m'
    : level === 'warn' ? '\x1b[33mWRN\x1b[0m'
    : '\x1b[36mINF\x1b[0m'
  const ctxParts = Object.entries(ctx)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ')
  const msgPart = msg ? ` ${msg}` : ''
  const ctxPart = ctxParts ? ` ${ctxParts}` : ''
  return `${time} ${levelTag} [${module}] ${action}${msgPart}${ctxPart}`
}

function emit(entry: LogEntry): void {
  const stream = entry.level === 'error' ? process.stderr : process.stdout
  if (IS_TTY) {
    stream.write(formatTTY(entry) + '\n')
  } else {
    stream.write(JSON.stringify(entry) + '\n')
  }
}

export interface Logger {
  info(action: string, ctx?: Record<string, unknown>): void
  warn(action: string, ctx?: Record<string, unknown>): void
  error(action: string, ctx?: Record<string, unknown>): void
}

export function createLogger(module: string): Logger {
  function log(level: LogLevel, action: string, ctx?: Record<string, unknown>): void {
    const entry: LogEntry = {
      ts: new Date().toISOString(),
      level,
      module,
      action,
      ...ctx,
    }
    emit(entry)
  }

  return {
    info: (action, ctx) => log('info', action, ctx),
    warn: (action, ctx) => log('warn', action, ctx),
    error: (action, ctx) => log('error', action, ctx),
  }
}
