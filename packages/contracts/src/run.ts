import { z } from 'zod'
import { providerNameSchema } from './provider.js'

export const runStatusSchema = z.enum(['queued', 'running', 'completed', 'partial', 'failed', 'cancelled'])
export type RunStatus = z.infer<typeof runStatusSchema>
export const RunStatuses = runStatusSchema.enum

export const runKindSchema = z.enum([
  'answer-visibility',
  'site-audit',
  'gsc-sync',
  'inspect-sitemap',
  'ga-sync',
  'bing-inspect',
  'bing-inspect-sitemap',
  'backlink-extract',
])
export type RunKind = z.infer<typeof runKindSchema>
export const RunKinds = runKindSchema.enum

export const runTriggerSchema = z.enum(['manual', 'scheduled', 'config-apply'])
export type RunTrigger = z.infer<typeof runTriggerSchema>
export const RunTriggers = runTriggerSchema.enum

export const citationStateSchema = z.enum(['cited', 'not-cited'])
export type CitationState = z.infer<typeof citationStateSchema>
export const CitationStates = citationStateSchema.enum

export const visibilityStateSchema = z.enum(['visible', 'not-visible'])
export type VisibilityState = z.infer<typeof visibilityStateSchema>
export const VisibilityStates = visibilityStateSchema.enum

export const computedTransitionSchema = z.enum(['new', 'cited', 'lost', 'emerging', 'not-cited'])
export type ComputedTransition = z.infer<typeof computedTransitionSchema>
export const ComputedTransitions = computedTransitionSchema.enum

export const runTriggerRequestSchema = z.object({
  kind: z.literal(RunKinds['answer-visibility']).optional(),
  trigger: z.literal(RunTriggers.manual).optional(),
  providers: z.array(providerNameSchema).optional(),
  location: z.string().min(1).optional(),
  allLocations: z.boolean().optional(),
  noLocation: z.boolean().optional(),
}).refine(
  (data) => Number(Boolean(data.location)) + Number(Boolean(data.allLocations)) + Number(Boolean(data.noLocation)) <= 1,
  { message: 'Only one of "location", "allLocations", or "noLocation" may be provided' },
)

export type RunTriggerRequest = z.infer<typeof runTriggerRequestSchema>

export const runProviderErrorSchema = z.object({
  /** Human-readable error message (best-effort extracted from `raw.error.message` / `raw.message`, otherwise the raw text with any `[provider-X]` prefix stripped). */
  message: z.string(),
  /** Original provider response payload, if the underlying error body parsed as JSON. Use this for structured fields like HTTP status, error code, etc. */
  raw: z.unknown().optional(),
})

export type RunProviderErrorDto = z.infer<typeof runProviderErrorSchema>

export const runErrorSchema = z.object({
  /** Top-level message for runs that failed without a per-provider error (e.g. user cancellation, internal scheduling failures). */
  message: z.string().optional(),
  /** Per-provider errors for visibility-sweep runs that had at least one provider fail. */
  providers: z.record(z.string(), runProviderErrorSchema).optional(),
})

export type RunErrorDto = z.infer<typeof runErrorSchema>

export const runDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: runKindSchema,
  status: runStatusSchema,
  trigger: runTriggerSchema.default('manual'),
  location: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
  error: runErrorSchema.nullable().optional(),
  createdAt: z.string(),
})

export type RunDto = z.infer<typeof runDtoSchema>

const PROVIDER_PREFIX = /^\[provider-[a-zA-Z0-9_-]+\]\s+/

/** Parse one provider's error message into a structured form. Strips any `[provider-X] ` prefix and attempts to parse the body as JSON. */
export function parseProviderErrorMessage(msg: string): RunProviderErrorDto {
  const stripped = msg.replace(PROVIDER_PREFIX, '')
  try {
    const raw: unknown = JSON.parse(stripped)
    if (raw && typeof raw === 'object') {
      const inner = raw as { error?: { message?: unknown }; message?: unknown }
      const fromErrorMessage = typeof inner.error?.message === 'string' ? inner.error.message : undefined
      const fromMessage = typeof inner.message === 'string' ? inner.message : undefined
      return { message: fromErrorMessage ?? fromMessage ?? stripped, raw }
    }
  } catch {
    // not JSON — fall through to plain message
  }
  return { message: stripped }
}

/**
 * Parse the `runs.error` DB column into the structured `RunErrorDto`.
 * Handles four shapes for back-compat:
 *   1. New per-provider:    `{"providers":{"gemini":{"message":"...","raw":{...}}}}`
 *   2. New top-level:       `{"message":"Cancelled by user"}`
 *   3. Legacy double-string: `{"gemini":"[provider-gemini] {...}"}`
 *   4. Plain string:         `Cancelled by user` (pre-structured cancellations)
 */
export function parseRunError(raw: string | null | undefined): RunErrorDto | null {
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { message: raw }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { message: raw }
  }
  const obj = parsed as Record<string, unknown>
  const hasProviders = obj.providers && typeof obj.providers === 'object'
  const hasMessage = typeof obj.message === 'string'
  if (hasProviders || hasMessage) {
    return parsed as RunErrorDto
  }
  // Legacy: { providerName: "[provider-X] msg..." }
  const providers: Record<string, RunProviderErrorDto> = {}
  for (const [name, val] of Object.entries(obj)) {
    providers[name] = parseProviderErrorMessage(typeof val === 'string' ? val : JSON.stringify(val))
  }
  return { providers }
}

/** Build a `RunErrorDto` from a map of provider → raw error message (the writer-side shape used in the job runner). */
export function buildRunErrorFromMessages(messages: Iterable<readonly [string, string]>): RunErrorDto {
  const providers: Record<string, RunProviderErrorDto> = {}
  for (const [name, msg] of messages) {
    providers[name] = parseProviderErrorMessage(msg)
  }
  return { providers }
}

/** Serialize a `RunErrorDto` for the `runs.error` DB column. */
export function serializeRunError(err: RunErrorDto): string {
  return JSON.stringify(err)
}

/**
 * One-line, human-readable summary of a `RunErrorDto`.
 * Use this anywhere a single string slot displays an error (CLI status
 * lines, toast notifications, table cells) so the structured shape never
 * leaks as `[object Object]`.
 */
export function formatRunErrorOneLine(err: RunErrorDto): string {
  if (err.providers) {
    const entries = Object.entries(err.providers)
    if (entries.length === 1) {
      const [provider, detail] = entries[0]!
      return `${provider}: ${detail.message}`
    }
    if (entries.length > 1) {
      return entries.map(([p, d]) => `${p}: ${d.message}`).join(' • ')
    }
  }
  return err.message ?? 'Run failed.'
}

export const groundingSourceSchema = z.object({
  uri: z.string(),
  title: z.string(),
})

export type GroundingSource = z.infer<typeof groundingSourceSchema>

export const querySnapshotDtoSchema = z.object({
  id: z.string(),
  runId: z.string(),
  keywordId: z.string(),
  keyword: z.string().optional(),
  provider: providerNameSchema,
  citationState: citationStateSchema,
  answerMentioned: z.boolean().optional(),
  visibilityState: visibilityStateSchema.optional(),
  transition: computedTransitionSchema.optional(),
  answerText: z.string().nullable().optional(),
  citedDomains: z.array(z.string()).default([]),
  competitorOverlap: z.array(z.string()).default([]),
  recommendedCompetitors: z.array(z.string()).default([]),
  matchedTerms: z.array(z.string()).default([]),
  groundingSources: z.array(groundingSourceSchema).default([]),
  searchQueries: z.array(z.string()).default([]),
  model: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  createdAt: z.string(),
})

export type QuerySnapshotDto = z.infer<typeof querySnapshotDtoSchema>

export const snapshotListResponseSchema = z.object({
  snapshots: z.array(querySnapshotDtoSchema),
  total: z.number().int().nonnegative(),
})

export type SnapshotListResponse = z.infer<typeof snapshotListResponseSchema>

export const snapshotDiffRowSchema = z.object({
  keywordId: z.string().nullable(),
  keyword: z.string().nullable(),
  run1State: citationStateSchema.nullable(),
  run2State: citationStateSchema.nullable(),
  run1AnswerMentioned: z.boolean().nullable(),
  run2AnswerMentioned: z.boolean().nullable(),
  run1VisibilityState: visibilityStateSchema.nullable(),
  run2VisibilityState: visibilityStateSchema.nullable(),
  changed: z.boolean(),
  visibilityChanged: z.boolean(),
})

export type SnapshotDiffRow = z.infer<typeof snapshotDiffRowSchema>

export const snapshotDiffResponseSchema = z.object({
  run1: z.string(),
  run2: z.string(),
  diff: z.array(snapshotDiffRowSchema),
})

export type SnapshotDiffResponse = z.infer<typeof snapshotDiffResponseSchema>

export const runDetailDtoSchema = runDtoSchema.extend({
  snapshots: z.array(querySnapshotDtoSchema).optional(),
})

export type RunDetailDto = z.infer<typeof runDetailDtoSchema>

export const latestProjectRunDtoSchema = z.object({
  totalRuns: z.number().int().nonnegative(),
  run: runDetailDtoSchema.nullable(),
})

export type LatestProjectRunDto = z.infer<typeof latestProjectRunDtoSchema>

export const auditLogEntrySchema = z.object({
  id: z.string(),
  projectId: z.string().nullable().optional(),
  actor: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable().optional(),
  diff: z.unknown().optional(),
  createdAt: z.string(),
})

export type AuditLogEntry = z.infer<typeof auditLogEntrySchema>
