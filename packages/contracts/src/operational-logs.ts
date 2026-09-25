import { z } from 'zod'

/** Runtime diagnostics are intentionally not audit history. */
export const operationalLogLevelSchema = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
export type OperationalLogLevel = z.infer<typeof operationalLogLevelSchema>

/** Logger-facing event shape. Only the allowlisted projection is retained. */
export interface RuntimeLogEvent {
  ts: string
  level: OperationalLogLevel
  module: string
  action: string
  msg?: string
  [key: string]: unknown
}

const diagnosticContextSchema = z.object({
  runId: z.string().min(1).max(256).optional(),
  projectId: z.string().min(1).max(256).optional(),
  requestId: z.string().min(1).max(256).optional(),
  actor: z.string().min(1).max(512).optional(),
  credentialId: z.string().min(1).max(512).optional(),
  userAgent: z.string().min(1).max(512).optional(),
  actorSession: z.string().min(1).max(512).optional(),
  method: z.string().min(1).max(16).optional(),
  route: z.string().min(1).max(256).optional(),
  operationId: z.string().min(1).max(256).optional(),
  jobId: z.string().min(1).max(256).optional(),
  taskId: z.string().min(1).max(256).optional(),
  traceId: z.string().min(1).max(256).optional(),
  provider: z.string().min(1).max(256).optional(),
  errorCode: z.string().min(1).max(128).optional(),
  attempt: z.number().finite().optional(),
  count: z.number().finite().optional(),
  total: z.number().finite().optional(),
  progress: z.number().finite().optional(),
  httpStatus: z.number().finite().optional(),
  statusCode: z.number().finite().optional(),
  durationMs: z.number().finite().optional(),
  bytes: z.number().finite().optional(),
  retryAfterMs: z.number().finite().optional(),
  retriable: z.boolean().optional(),
  retrying: z.boolean().optional(),
  cancelled: z.boolean().optional(),
  success: z.boolean().optional(),
}).strict()
export type OperationalLogContext = z.infer<typeof diagnosticContextSchema>

export const operationalLogEntryDtoSchema = z.object({
  cursor: z.string().min(1).max(512),
  ts: z.string().datetime(),
  level: operationalLogLevelSchema,
  module: z.string().min(1).max(256),
  action: z.string().min(1).max(256),
  message: z.string().max(4096).optional(),
  runId: z.string().min(1).max(256).optional(),
  projectId: z.string().min(1).max(256).optional(),
  context: diagnosticContextSchema,
}).strict()
export type OperationalLogEntryDto = z.infer<typeof operationalLogEntryDtoSchema>

/** Query accepted by the operational diagnostic endpoint. */
export const logQuerySchema = z.object({
  level: operationalLogLevelSchema.optional(),
  module: z.string().trim().min(1).max(256).optional(),
  runId: z.string().trim().min(1).max(256).optional(),
  projectId: z.string().trim().min(1).max(256).optional(),
  actor: z.string().trim().min(1).max(512).optional(),
  requestId: z.string().trim().min(1).max(256).optional(),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  cursor: z.string().trim().min(1).max(512).optional(),
}).strict().superRefine((query, ctx) => {
  if (query.since && query.until && Date.parse(query.since) > Date.parse(query.until)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['until'], message: '"until" must be on or after "since".' })
  }
})
export type LogQuery = z.infer<typeof logQuerySchema>

const retentionPolicySchema = z.object({
  maxEntries: z.number().int().positive(),
  maxAgeSeconds: z.number().int().positive(),
}).strict()

export const operationalLogListDtoSchema = z.object({
  entries: z.array(operationalLogEntryDtoSchema),
  nextCursor: z.string().min(1).max(512).nullable(),
  /** Matching entries left after this page. */
  truncated: z.number().int().nonnegative(),
  /** Entries evicted by the active retention policy. */
  dropped: z.number().int().nonnegative(),
  retention: z.enum(['process', 'durable']),
  retentionPolicy: retentionPolicySchema.optional(),
  /** Best-effort persistence failures observed by this store. */
  captureErrors: z.number().int().nonnegative().optional(),
  observedAt: z.string().datetime(),
}).strict()
export type OperationalLogListDto = z.infer<typeof operationalLogListDtoSchema>

/**
 * Request header naming the opt-in context fields a caller can read, as a
 * comma-separated list. Unknown names are ignored.
 *
 * A reader built before a context field existed validates pages with the
 * strict schemas above, so one unrecognized key costs it the whole page. The
 * server therefore returns a field added after that contract only to a caller
 * that asks for it by name. Older servers ignore the header, so sending it is
 * always safe. It is a header rather than a query parameter because
 * `logQuerySchema` is strict too: a new parameter would get a 400 from them.
 */
export const OPERATIONAL_LOG_FIELDS_HEADER = 'x-canonry-log-fields'
/** Context fields returned only when named in `OPERATIONAL_LOG_FIELDS_HEADER`. */
export const OPERATIONAL_LOG_OPT_IN_CONTEXT_FIELDS = ['provider'] as const
export type OperationalLogOptInContextField = typeof OPERATIONAL_LOG_OPT_IN_CONTEXT_FIELDS[number]

/**
 * Client-side reader for a log page. The DTO schemas above stay strict because
 * they are the server's redaction boundary: only known context keys may be
 * saved or returned. A client reading a response instead drops keys it does not
 * know, so a field added by a newer server never rejects a page again. Known
 * fields keep their bounds.
 */
const diagnosticContextReadSchema = z.object(diagnosticContextSchema.shape)
const operationalLogEntryReadSchema = z.object({ ...operationalLogEntryDtoSchema.shape, context: diagnosticContextReadSchema })
export const operationalLogListReadSchema = z.object({
  ...operationalLogListDtoSchema.shape,
  entries: z.array(operationalLogEntryReadSchema),
  retentionPolicy: z.object(retentionPolicySchema.shape).optional(),
})
