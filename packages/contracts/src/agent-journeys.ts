import { z } from 'zod'
import { trafficSourceTypeSchema, trafficVerificationManifestSchema, verificationStatusSchema } from './traffic.js'

export const AGENT_JOURNEY_RETENTION_DAYS = 30
export const AGENT_JOURNEY_DAILY_EVENT_LIMIT = 10_000
export const AGENT_JOURNEY_IDLE_MINUTES = 30
export const AGENT_JOURNEY_READ_EVENT_LIMIT = 20_000

/** Operator verification never establishes continuity of a user's task. */
export const agentJourneyCorrelationBasisSchema = z.enum(['ip-ua', 'unlinked'])
export const AgentJourneyCorrelationBases = agentJourneyCorrelationBasisSchema.enum
export type AgentJourneyCorrelationBasis = z.infer<typeof agentJourneyCorrelationBasisSchema>

const instant = z.union([z.iso.datetime({ offset: true }), z.iso.date()])
/** All selectors are read identity; limit/offset tune pagination only. */
export const agentJourneysQuerySchema = z.object({
  since: instant.optional(),
  until: instant.optional(),
  sourceId: z.string().min(1).max(256).optional(),
  agentId: z.string().min(1).max(128).optional(),
  verificationStatus: verificationStatusSchema.optional(),
  targetKey: z.string().min(1).max(128).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
}).strict()
export type AgentJourneysQuery = z.infer<typeof agentJourneysQuerySchema>

export const agentJourneyAttributionSchema = z.enum(['matched', 'unmatched', 'ambiguous', 'unknown-host', 'redacted', 'not-configured'])
export const AgentJourneyAttributions = agentJourneyAttributionSchema.enum

export const agentJourneyEventSchema = z.object({
  id: z.string(),
  ts: z.string(),
  host: z.string().nullable(),
  path: z.string(),
  method: z.string().nullable(),
  status: z.number().int().nullable(),
  latencyMs: z.number().nonnegative().nullable(),
  verificationStatus: verificationStatusSchema,
  verificationManifest: trafficVerificationManifestSchema.nullable(),
  targetKey: z.string().nullable(),
  attribution: agentJourneyAttributionSchema,
})
export type AgentJourneyEvent = z.infer<typeof agentJourneyEventSchema>

export const agentJourneySchema = z.object({
  /** An event anchor, resolvable after late arrivals change the start of a sequence. */
  id: z.string(),
  sourceId: z.string(),
  agentId: z.string(),
  operator: z.string(),
  product: z.string(),
  correlationBasis: agentJourneyCorrelationBasisSchema,
  correlation: z.enum(['inferred', 'unlinked']),
  startedAt: z.string(),
  endedAt: z.string(),
  firstHost: z.string().nullable(),
  firstPath: z.string(),
  lastPath: z.string(),
  requestCount: z.number().int().nonnegative(),
  /** HTTP 400–599 only; neither other statuses nor paths prove task success. */
  errorCount: z.number().int().nonnegative(),
  verificationStatuses: z.array(verificationStatusSchema),
  targetKeys: z.array(z.string()),
})
export type AgentJourney = z.infer<typeof agentJourneySchema>

const agentJourneyContextSchema = z.object({
  scope: z.object({
    project: z.string(),
    sourceId: z.string().nullable(),
    agentId: z.string().nullable(),
    verificationStatus: verificationStatusSchema.nullable(),
    targetKey: z.string().nullable(),
    mode: z.enum(['simple', 'advanced']),
    planRevision: z.number().int().nullable(),
    attribution: z.enum(['project', 'current-plan-url']),
    unavailableDimensions: z.array(z.enum(['market', 'query', 'query-class', 'model', 'task'])),
  }),
  windowStart: z.string(),
  windowEnd: z.string(),
  properties: z.array(z.object({ key: z.string(), label: z.string() })),
  coverage: z.object({
    recordingEnabled: z.boolean(),
    retentionDays: z.number().int(),
    idleMinutes: z.number().int(),
    dailyEventLimit: z.number().int(),
    windowBounded: z.literal(true),
    cappedSourceDays: z.array(z.object({ sourceId: z.string(), day: z.string() })),
    sources: z.array(z.object({
      sourceId: z.string(),
      sourceType: trafficSourceTypeSchema,
      label: z.string(),
      limitations: z.array(z.string()),
    })),
    limitations: z.array(z.string()),
  }),
})
export type AgentJourneyContext = z.infer<typeof agentJourneyContextSchema>

export const agentJourneysResponseSchema = agentJourneyContextSchema.extend({
  observedRequests: z.number().int().nonnegative(),
  totalJourneys: z.number().int().nonnegative(),
  limit: z.number().int(),
  offset: z.number().int(),
  journeys: z.array(agentJourneySchema),
})
export type AgentJourneysResponse = z.infer<typeof agentJourneysResponseSchema>

export const agentJourneyDetailResponseSchema = agentJourneyContextSchema.extend({
  journey: agentJourneySchema,
  totalEvents: z.number().int().nonnegative(),
  limit: z.number().int(),
  offset: z.number().int(),
  events: z.array(agentJourneyEventSchema),
})
export type AgentJourneyDetailResponse = z.infer<typeof agentJourneyDetailResponseSchema>
