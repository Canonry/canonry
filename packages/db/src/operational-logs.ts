import { createHash, randomUUID } from 'node:crypto'
import { sql, type SQL } from 'drizzle-orm'
import {
  logQuerySchema,
  diagnosticIdentity,
  operationalLogEntryDtoSchema,
  redactLogString,
  redactLogValue,
  validationError,
  type LogQuery,
  type OperationalLogContext,
  type OperationalLogEntryDto,
  type OperationalLogListDto,
  type RuntimeLogEvent,
} from '@ainyc/canonry-contracts'
import type { DatabaseClient } from './client.js'
import { parseJsonColumn } from './json.js'

const METADATA_ID = 'runtime-log-store'
const DEFAULT_MAX_ENTRIES = 10_000
const MAX_MAX_ENTRIES = 100_000
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000
const MIN_MAX_AGE_MS = 1_000
const MAX_MAX_AGE_MS = 31 * 24 * 60 * 60 * 1_000
const MAX_ENTRY_BYTES = 8_192

type SqlDb = Pick<DatabaseClient, 'all' | 'run'>

interface MetadataRow {
  cursorNamespace: string
  nextSequence: number
  dropped: number
  captureErrors: number
}

interface RuntimeLogRow {
  sequence: number
  ts: string
  level: string
  module: string
  action: string
  msg: string | null
  projectId: string | null
  runId: string | null
  actor: string | null
  requestId: string | null
  context: string | Record<string, unknown>
}

export interface OperationalLogStoreOptions {
  maxEntries?: number
  maxAgeMs?: number
  retention?: 'process' | 'durable'
  now?: () => Date
}

/**
 * Best-effort, restart-safe operational log persistence. It keeps a small,
 * sanitized projection only; a failure here never interrupts business work.
 */
export class OperationalLogStore {
  private readonly maxEntries: number
  private readonly maxAgeMs: number
  private readonly retention: 'process' | 'durable'
  private readonly now: () => Date
  private localCaptureErrors = 0

  constructor(private readonly db: DatabaseClient, options: OperationalLogStoreOptions = {}) {
    this.maxEntries = boundedInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, 1, MAX_MAX_ENTRIES, 'maxEntries')
    this.maxAgeMs = boundedInteger(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS, MIN_MAX_AGE_MS, MAX_MAX_AGE_MS, 'maxAgeMs')
    this.retention = options.retention ?? 'durable'
    this.now = options.now ?? (() => new Date())
    this.ensureMetadata()
  }

  append(event: RuntimeLogEvent): void {
    try {
      const entry = projectEvent(event)
      if (Buffer.byteLength(JSON.stringify(entry), 'utf8') > MAX_ENTRY_BYTES) {
        throw new RangeError(`Operational log entry exceeds ${MAX_ENTRY_BYTES} bytes.`)
      }
      this.withoutLockWait(() => this.db.transaction((tx) => {
        this.prune(tx)
        const metadata = readMetadata(tx)
        tx.run(sql`
          INSERT INTO runtime_logs (
            sequence, ts, level, module, action, msg, project_id, run_id, actor, request_id, context, entry_bytes
          ) VALUES (
            ${metadata.nextSequence}, ${entry.ts}, ${entry.level}, ${entry.module}, ${entry.action}, ${entry.message ?? null},
            ${entry.projectId ?? null}, ${entry.runId ?? null}, ${entry.context.actor ?? null}, ${entry.context.requestId ?? null},
            ${JSON.stringify(entry.context)}, ${Buffer.byteLength(JSON.stringify(entry), 'utf8')}
          )
        `)
        tx.run(sql`UPDATE runtime_log_metadata SET next_sequence = ${metadata.nextSequence + 1} WHERE id = ${METADATA_ID}`)
        this.prune(tx)
      }))
    } catch {
      this.recordCaptureError()
    }
  }

  list(query: LogQuery): OperationalLogListDto {
    const parsed = logQuerySchema.safeParse(query)
    if (!parsed.success) throw validationError('Invalid operational logs query.', { issues: parsed.error.issues })
    const filters = normalizeLogQuery(parsed.data)
    this.withoutLockWait(() => this.db.transaction((tx) => { this.prune(tx) }))
    const metadata = readMetadata(this.db)
    const after = filters.cursor === undefined ? 0 : this.parseCursor(filters.cursor, metadata, filters)
    if (filters.cursor !== undefined) this.assertCursorCurrent(after)

    const where = buildWhere(filters, after)
    const rows = this.db.all(sql`
      SELECT sequence, ts, level, module, action, msg,
             project_id AS projectId, run_id AS runId, actor, request_id AS requestId, context
        FROM runtime_logs
       WHERE ${sql.join(where, sql` AND `)}
       ORDER BY sequence ASC
       LIMIT ${filters.limit}
    `) as RuntimeLogRow[]
    const countRows = this.db.all(sql`
      SELECT COUNT(*) AS count FROM runtime_logs WHERE ${sql.join(where, sql` AND `)}
    `) as Array<{ count: number }>
    const matching = countRows[0]?.count
    if (!Number.isSafeInteger(matching) || matching < rows.length) throw new Error('Operational log storage returned an invalid count.')
    const truncated = matching - rows.length

    return {
      entries: rows.map((row) => this.toDto(row, metadata.cursorNamespace, filters)),
      nextCursor: truncated > 0 ? this.cursorFor(metadata.cursorNamespace, rows.at(-1)!.sequence, filters) : null,
      truncated,
      dropped: metadata.dropped,
      retention: this.retention,
      retentionPolicy: { maxEntries: this.maxEntries, maxAgeSeconds: Math.ceil(this.maxAgeMs / 1_000) },
      captureErrors: metadata.captureErrors + this.localCaptureErrors,
      observedAt: this.now().toISOString(),
    }
  }

  private ensureMetadata(): void {
    const existing = this.db.all(sql`SELECT id FROM runtime_log_metadata WHERE id = ${METADATA_ID}`) as Array<{ id: string }>
    if (existing.length > 0) return
    this.db.run(sql`
      INSERT OR IGNORE INTO runtime_log_metadata (id, cursor_namespace, next_sequence, dropped, capture_errors)
      VALUES (${METADATA_ID}, ${randomUUID()}, 1, 0, 0)
    `)
  }

  private prune(db: SqlDb): void {
    const expiry = new Date(this.now().getTime() - this.maxAgeMs).toISOString()
    db.run(sql`DELETE FROM runtime_logs WHERE ts < ${expiry}`)
    db.run(sql`UPDATE runtime_log_metadata SET dropped = dropped + changes() WHERE id = ${METADATA_ID}`)
    const metadata = readMetadata(db)
    const firstRetainedSequence = Math.max(1, metadata.nextSequence - this.maxEntries)
    db.run(sql`DELETE FROM runtime_logs WHERE sequence < ${firstRetainedSequence}`)
    db.run(sql`UPDATE runtime_log_metadata SET dropped = dropped + changes() WHERE id = ${METADATA_ID}`)
  }

  private recordCaptureError(): void {
    // A failed INSERT is deliberately not logged through this store: doing so
    // would recurse forever on a full, locked, or damaged database.
    try {
      this.withoutLockWait(() => this.db.run(sql`UPDATE runtime_log_metadata SET capture_errors = capture_errors + 1 WHERE id = ${METADATA_ID}`))
    } catch {
      this.localCaptureErrors++
    }
  }

  /**
   * Diagnostics must not spend the application's busy timeout waiting for a
   * writer. All work here is synchronous, so restore the connection's exact
   * policy before any other application work can run, including on failure.
   */
  private withoutLockWait<T>(work: () => T): T {
    const timeout = this.db.$client.pragma('busy_timeout', { simple: true }) as number
    try {
      this.db.$client.pragma('busy_timeout = 0')
      return work()
    } finally {
      this.db.$client.pragma(`busy_timeout = ${timeout}`)
    }
  }

  private parseCursor(cursor: string, metadata: MetadataRow, filters: Omit<LogQuery, 'cursor'> & { cursor?: string }): number {
    let decoded: unknown
    try {
      decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    } catch {
      throw validationError('The operational-log cursor is invalid.')
    }
    if (!isCursorPayload(decoded)) throw validationError('The operational-log cursor is invalid.')
    if (decoded.namespace !== metadata.cursorNamespace) throw validationError('The operational-log cursor belongs to a different database.')
    if (decoded.filters !== filterHash(filters)) throw validationError('The operational-log cursor does not match these query filters.')
    if (decoded.sequence < 1 || decoded.sequence >= metadata.nextSequence) throw validationError('The operational-log cursor is invalid.')
    return decoded.sequence
  }

  private assertCursorCurrent(sequence: number): void {
    const rows = this.db.all(sql`SELECT sequence FROM runtime_logs WHERE sequence = ${sequence}`) as Array<{ sequence: number }>
    if (rows.length === 0) throw validationError('The operational-log cursor is stale because retention evicted its entry.')
  }

  private cursorFor(namespace: string, sequence: number, filters: Omit<LogQuery, 'cursor'> & { cursor?: string }): string {
    return Buffer.from(JSON.stringify({ namespace, sequence, filters: filterHash(filters) }), 'utf8').toString('base64url')
  }

  private toDto(row: RuntimeLogRow, namespace: string, filters: Omit<LogQuery, 'cursor'> & { cursor?: string }): OperationalLogEntryDto {
    const context = parseContext(row.context)
    const entry = {
      cursor: this.cursorFor(namespace, row.sequence, filters),
      ts: redactLogString(row.ts),
      level: redactLogString(row.level),
      module: redactLogString(row.module),
      action: redactLogString(row.action),
      ...(row.msg === null ? {} : { message: clip(redactLogString(row.msg), 4096) }),
      ...(row.runId === null ? {} : { runId: clip(redactLogString(row.runId), 256) }),
      ...(row.projectId === null ? {} : { projectId: clip(redactLogString(row.projectId), 256) }),
      context,
    }
    return operationalLogEntryDtoSchema.parse(entry)
  }
}

function projectEvent(event: RuntimeLogEvent): Omit<OperationalLogEntryDto, 'cursor'> {
  const value = redactLogValue(event)
  if (!isRecord(value)) throw new TypeError('Operational log event must be an object.')
  const contextSource = isRecord(value.context) ? value.context : {}
  const context = projectContext(value, contextSource)
  const entry = {
    ts: new Date(requiredString(value.ts, 64, 'timestamp')).toISOString(),
    level: requiredString(value.level, 16, 'level'),
    module: requiredString(value.module, 256, 'module'),
    action: requiredString(value.action, 256, 'action'),
    ...(optionalString(value.msg, 4096) === undefined ? {} : { message: optionalString(value.msg, 4096) }),
    ...(context.runId === undefined ? {} : { runId: context.runId }),
    ...(context.projectId === undefined ? {} : { projectId: context.projectId }),
    context,
  }
  return operationalLogEntryDtoSchema.omit({ cursor: true }).parse(entry)
}

function projectContext(event: Record<string, unknown>, nested: Record<string, unknown>): OperationalLogContext {
  const context: Record<string, unknown> = {}
  for (const [key, max] of ID_FIELDS) {
    const raw = event[key] ?? nested[key]
    const value = diagnosticIdentity(key, raw) ?? optionalString(raw, max)
    if (value !== undefined) context[key] = value
  }
  for (const key of NUMBER_FIELDS) {
    const value = event[key] ?? nested[key]
    if (typeof value === 'number' && Number.isFinite(value)) context[key] = value
  }
  for (const key of BOOLEAN_FIELDS) {
    const value = event[key] ?? nested[key]
    if (typeof value === 'boolean') context[key] = value
  }
  const errorCode = optionalString(event.errorCode ?? nested.errorCode, 128)
  if (errorCode !== undefined) context.errorCode = errorCode
  return context as OperationalLogContext
}

const ID_FIELDS = [
  ['runId', 256], ['projectId', 256], ['requestId', 256], ['actor', 512], ['credentialId', 512], ['userAgent', 512], ['actorSession', 512],
  ['operationId', 256], ['jobId', 256], ['taskId', 256], ['traceId', 256],
  ['method', 16], ['route', 256],
] as const
const NUMBER_FIELDS = ['attempt', 'count', 'total', 'progress', 'httpStatus', 'statusCode', 'durationMs', 'bytes', 'retryAfterMs'] as const
const BOOLEAN_FIELDS = ['retriable', 'retrying', 'cancelled', 'success'] as const

function buildWhere(query: LogQuery, after: number): SQL[] {
  const where: SQL[] = [sql`sequence > ${after}`]
  if (query.level !== undefined) where.push(sql`level = ${query.level}`)
  if (query.module !== undefined) where.push(sql`module = ${query.module}`)
  if (query.runId !== undefined) where.push(sql`run_id = ${query.runId}`)
  if (query.projectId !== undefined) where.push(sql`project_id = ${query.projectId}`)
  if (query.actor !== undefined) where.push(sql`actor = ${query.actor}`)
  if (query.requestId !== undefined) where.push(sql`request_id = ${query.requestId}`)
  if (query.since !== undefined) where.push(sql`ts >= ${query.since}`)
  if (query.until !== undefined) where.push(sql`ts <= ${query.until}`)
  return where
}

function readMetadata(db: SqlDb): MetadataRow {
  const rows = db.all(sql`
    SELECT cursor_namespace AS cursorNamespace, next_sequence AS nextSequence, dropped, capture_errors AS captureErrors
      FROM runtime_log_metadata WHERE id = ${METADATA_ID}
  `) as MetadataRow[]
  const metadata = rows[0] as MetadataRow | undefined
  if (metadata === undefined || !Number.isSafeInteger(metadata.nextSequence) || metadata.nextSequence < 1) {
    throw new Error('Operational log metadata is missing or corrupt.')
  }
  return metadata
}

function parseContext(value: RuntimeLogRow['context']): OperationalLogContext {
  const parsed: unknown = typeof value === 'string' ? parseJsonColumn<unknown>(value, undefined) : value
  const redacted = redactLogValue(parsed)
  if (!isRecord(redacted)) throw new Error('Operational log context is corrupt.')
  return redacted as OperationalLogContext
}

function filterHash(query: Omit<LogQuery, 'cursor'> & { cursor?: string }): string {
  const stable = JSON.stringify({
    level: query.level ?? null, module: query.module ?? null, runId: query.runId ?? null, projectId: query.projectId ?? null,
    actor: query.actor ?? null, requestId: query.requestId ?? null, since: query.since ?? null, until: query.until ?? null,
  })
  return createHash('sha256').update(stable).digest('base64url')
}

function normalizeLogQuery(query: LogQuery): LogQuery {
  return {
    ...query,
    ...(query.since === undefined ? {} : { since: new Date(query.since).toISOString() }),
    ...(query.until === undefined ? {} : { until: new Date(query.until).toISOString() }),
  }
}

function isCursorPayload(value: unknown): value is { namespace: string; sequence: number; filters: string } {
  return isRecord(value) && typeof value.namespace === 'string' && Number.isSafeInteger(value.sequence) && typeof value.filters === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requiredString(value: unknown, max: number, label: string): string {
  const string = optionalString(value, max)
  if (string === undefined) throw new TypeError(`Operational log ${label} must be a non-empty string.`)
  return string
}

function optionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return clip(redactLogString(value), max)
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max)
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer from ${min} to ${max}.`)
  }
  return value
}
