/**
 * The strict runtime-log page contract that shipped first (#1148, v5.3.1) and
 * that every adapter built before #1209 validates pages with. Copied, not
 * imported, so it stays that older contract: `canonry-mcp` and `canonry logs`
 * from those builds reject a whole page on any key, enum value or bound this
 * contract does not allow. Do not edit it to match a newer contract.
 */
import { z } from 'zod'

export const legacyOperationalLogContextSchema = z.object({
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

export const legacyOperationalLogEntrySchema = z.object({
  cursor: z.string().min(1).max(512),
  ts: z.string().datetime(),
  level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
  module: z.string().min(1).max(256),
  action: z.string().min(1).max(256),
  message: z.string().max(4096).optional(),
  runId: z.string().min(1).max(256).optional(),
  projectId: z.string().min(1).max(256).optional(),
  context: legacyOperationalLogContextSchema,
}).strict()

export const legacyOperationalLogPageSchema = z.object({
  entries: z.array(legacyOperationalLogEntrySchema),
  nextCursor: z.string().min(1).max(512).nullable(),
  truncated: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
  retention: z.enum(['process', 'durable']),
  retentionPolicy: z.object({
    maxEntries: z.number().int().positive(),
    maxAgeSeconds: z.number().int().positive(),
  }).strict().optional(),
  captureErrors: z.number().int().nonnegative().optional(),
  observedAt: z.string().datetime(),
}).strict()
