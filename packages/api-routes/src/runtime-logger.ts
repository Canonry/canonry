import { format } from 'node:util'
import {
  redactLogString,
  redactLogValue,
  diagnosticIdentity,
  type OperationalLogLevel,
  type RuntimeLogEvent,
} from '@ainyc/canonry-contracts'
import type { FastifyBaseLogger } from 'fastify'
import { getRequestContext } from './request-context.js'

const IS_TTY = process.stdout.isTTY === true
const MAX_IDENTITY_LENGTH = 512
const RESERVED_FIELDS = new Set([
  'ts', 'level', 'module', 'action', 'msg',
  'requestId', 'actor', 'credentialId', 'userAgent', 'actorSession', '__runtimeRequestId',
])

export type LogLevel = OperationalLogLevel
export type LogEntry = RuntimeLogEvent

export interface Logger {
  info(action: string, ctx?: Record<string, unknown>): void
  warn(action: string, ctx?: Record<string, unknown>): void
  error(action: string, ctx?: Record<string, unknown>): void
}

export interface CreateFastifyLoggerOptions {
  enabled?: boolean
  module?: string
}

type LogListener = (entry: LogEntry) => void
const listeners = new Set<LogListener>()

/** Subscribe synchronously to sanitized runtime events. Listener faults are isolated. */
export function addLogListener(listener: LogListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Compatibility logger for CLI and worker callers. */
export function createLogger(module: string): Logger {
  const emit = (level: LogLevel, action: string, context?: Record<string, unknown>) => {
    const msg = context ? safeProperty(context, 'msg') : undefined
    emitRuntimeLog({ level, module, action, context, ...(typeof msg === 'string' ? { msg } : {}) })
  }
  return {
    info: (action, ctx) => emit('info', action, ctx),
    warn: (action, ctx) => emit('warn', action, ctx),
    error: (action, ctx) => emit('error', action, ctx),
  }
}

/**
 * A small Fastify/Pino-compatible logger that feeds the same sanitizer and
 * listener stream as createLogger without taking a runtime dependency on Pino.
 */
export function createFastifyLogger(options: CreateFastifyLoggerOptions = {}): FastifyBaseLogger {
  return buildFastifyLogger(options.module ?? 'HTTP', options.enabled !== false, {})
}

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: Infinity } as const

function buildFastifyLogger(module: string, enabled: boolean, bindings: Record<string, unknown>, inheritedLevel = 'info'): FastifyBaseLogger {
  let level = inheritedLevel
  const emit = (severity: LogLevel, args: unknown[]) => {
    if (LEVELS[severity] >= LEVELS[level as keyof typeof LEVELS]) logFastify(severity, module, enabled, bindings, args)
  }
  const logger = {
    get level() { return level },
    set level(value: string) { if (Object.hasOwn(LEVELS, value)) level = value },
    trace: (...args: unknown[]) => emit('trace', args),
    debug: (...args: unknown[]) => emit('debug', args),
    info: (...args: unknown[]) => emit('info', args),
    warn: (...args: unknown[]) => emit('warn', args),
    error: (...args: unknown[]) => emit('error', args),
    fatal: (...args: unknown[]) => emit('fatal', args),
    silent: () => undefined,
    child: (childBindings: unknown) => buildFastifyLogger(module, enabled, mergeBindings(bindings, childBindings), level),
  }
  return logger as FastifyBaseLogger
}

function logFastify(
  level: LogLevel,
  module: string,
  enabled: boolean,
  bindings: Record<string, unknown>,
  args: unknown[],
): void {
  const { context, msg } = normalizePinoArgs(args)
  emitRuntimeLog({
    level,
    module,
    action: `fastify.${level}`,
    msg,
    context: { ...bindings, ...context },
    trustedRequestId: asBoundString(bindings.__runtimeRequestId),
    enabled,
  })
}

function normalizePinoArgs(args: unknown[]): { context: Record<string, unknown>; msg?: string } {
  const first = args[0]
  const second = args[1]
  if (typeof first === 'string') return { context: {}, msg: safeFormat(first, args.slice(1)) }
  if (first instanceof Error) {
    return { context: { err: first }, msg: typeof second === 'string' ? safeFormat(second, args.slice(2)) : undefined }
  }
  if (isObject(first)) {
    return { context: copyOwnData(first), msg: typeof second === 'string' ? safeFormat(second, args.slice(2)) : undefined }
  }
  return { context: {}, msg: typeof second === 'string' ? safeFormat(second, args.slice(2)) : undefined }
}

function emitRuntimeLog({
  level,
  module,
  action,
  msg,
  context,
  trustedRequestId,
  enabled = true,
}: {
  level: LogLevel
  module: string
  action: string
  msg?: string
  context?: Record<string, unknown>
  trustedRequestId?: string
  enabled?: boolean
}): void {
  const safeContext = sanitizeContext(context)
  const error = safeContext.err ?? safeContext.error
  const errorMessage = typeof error === 'string' ? error : isRecord(error) && typeof error.message === 'string' ? error.message : undefined
  const message = errorMessage && errorMessage !== msg ? [msg, errorMessage].filter(Boolean).join(': ') : msg
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    module: boundText(module, 'Runtime'),
    action: boundText(action, 'log'),
    ...(message === undefined ? {} : { msg: redactLogString(message) }),
    ...safeContext,
    ...trustedAttribution(getRequestContext(trustedRequestId), trustedRequestId),
  }
  if (enabled) writeEntry(entry)
  for (const listener of listeners) {
    try { listener(entry) } catch { /* optional capture must not break logging */ }
  }
}

function sanitizeContext(context: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!context) return {}
  const output: Record<string, unknown> = {}
  for (const key of safeKeys(context).slice(0, 100)) {
    if (RESERVED_FIELDS.has(key)) continue
    const value = safeProperty(context, key)
    if (key === 'req' || key === 'request') {
      Object.assign(output, normalizeRequest(value))
      continue
    }
    if (key === 'res' || key === 'reply') {
      Object.assign(output, normalizeReply(value))
      continue
    }
    if (key === 'responseTime' || key === 'duration') {
      if (typeof value === 'number' && Number.isFinite(value)) output.durationMs = value
      continue
    }
    output[key] = value
  }
  delete output.__runtimeRequestId
  const redacted = redactLogValue(output)
  return isRecord(redacted) ? redacted : {}
}

function trustedAttribution(context: ReturnType<typeof getRequestContext>, trustedRequestId?: string): Record<string, unknown> {
  const requestId = boundOptional(context?.requestId) ?? trustedRequestId
  const actor = diagnosticIdentity('actor', context?.actor)
  const credentialId = diagnosticIdentity('credentialId', context?.credentialId)
  const userAgent = boundOptional(context?.userAgent)
  const actorSession = boundOptional(context?.actorSession)
  const method = boundOptional(context?.method)
  const route = boundOptional(context?.route)
  return {
    ...(requestId ? { requestId } : {}),
    ...(actor ? { actor } : {}),
    ...(credentialId ? { credentialId } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(actorSession ? { actorSession } : {}),
    ...(method ? { method } : {}),
    ...(route ? { route } : {}),
    ...(context?.statusCode === undefined ? {} : { statusCode: context.statusCode }),
  }
}

function mergeBindings(parent: Record<string, unknown>, child: unknown): Record<string, unknown> {
  const merged = { ...parent }
  if (!isObject(child)) return merged
  for (const key of safeKeys(child).slice(0, 100)) {
    const value = safeProperty(child, key)
    if (key === 'req' || key === 'request') Object.assign(merged, normalizeRequest(value))
    else if (key === 'res' || key === 'reply') Object.assign(merged, normalizeReply(value))
    else if (key === 'reqId') {
      merged.reqId = value
      merged.__runtimeRequestId = value
    }
    else if (!RESERVED_FIELDS.has(key)) merged[key] = value
  }
  return merged
}

function normalizeRequest(value: unknown): Record<string, unknown> {
  if (!isObject(value)) return {}
  const id = asBoundString(safeProperty(value, 'id'))
  const method = asBoundString(safeProperty(value, 'method'))
  const routeOptions = safeProperty(value, 'routeOptions')
  const route = isObject(routeOptions) ? asBoundString(safeProperty(routeOptions, 'url')) : undefined
  return {
    ...(id ? { reqId: id, __runtimeRequestId: id } : {}),
    ...(method ? { method } : {}),
    ...(route ? { route } : {}),
  }
}

function normalizeReply(value: unknown): Record<string, unknown> {
  if (!isObject(value)) return {}
  const statusCode = safeProperty(value, 'statusCode')
  return typeof statusCode === 'number' && Number.isFinite(statusCode) ? { statusCode } : {}
}

function writeEntry(entry: LogEntry): void {
  const stream = entry.level === 'error' || entry.level === 'fatal' ? process.stderr : process.stdout
  const line = IS_TTY ? formatTTY(entry) : JSON.stringify(entry)
  try { stream.write(`${line}\n`) } catch { /* a broken output stream cannot break the server */ }
}

function formatTTY(entry: LogEntry): string {
  const { ts, level, module, action, msg, ...context } = entry
  const levelTag = level === 'fatal' || level === 'error' ? 'ERR' : level === 'warn' ? 'WRN' : 'INF'
  const parts = safeKeys(context).map(key => `${key}=${safeDisplay(safeProperty(context, key))}`)
  return `${ts.slice(11, 19)} ${levelTag} [${module}] ${action}${msg ? ` ${msg}` : ''}${parts.length ? ` ${parts.join(' ')}` : ''}`
}

function safeDisplay(value: unknown): string {
  try { return typeof value === 'string' ? value : JSON.stringify(value) } catch { return '[UNSERIALIZABLE]' }
}

function safeFormat(message: string, args: unknown[]): string {
  try { return args.length ? format(message, ...args) : message } catch { return message }
}

function isObject(value: unknown): value is object { return value !== null && typeof value === 'object' }
function isRecord(value: unknown): value is Record<string, unknown> { return isObject(value) && !Array.isArray(value) }
function safeKeys(value: object): string[] { try { return Object.keys(value) } catch { return [] } }
function safeProperty(value: object, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor && 'value' in descriptor ? descriptor.value : undefined
  } catch { return undefined }
}
function copyOwnData(value: object): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const key of safeKeys(value)) output[key] = safeProperty(value, key)
  return output
}
function boundText(value: string, fallback: string): string { return boundOptional(value) ?? fallback }
function asBoundString(value: unknown): string | undefined { return typeof value === 'string' ? boundOptional(value) : undefined }
function boundOptional(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const redacted = redactLogString(value).replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_IDENTITY_LENGTH)
  return redacted || undefined
}
