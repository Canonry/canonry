import { z } from 'zod'
import { calendarDateSchema } from './google-ads.js'

/** Read-time tuning only; never changes stored evidence or existing headlines. */
export const referralAssessmentQuerySchema = z.object({
  startDate: calendarDateSchema,
  endDate: calendarDateSchema,
  sourceId: z.string().trim().min(1).optional(),
  burstThreshold: z.number().int().min(1).max(1_000_000).optional(),
  ratioThreshold: z.number().min(1).max(1_000).optional(),
  limit: z.number().int().min(1).max(500).optional(),
}).strict()
export type ReferralAssessmentQuery = z.infer<typeof referralAssessmentQuerySchema>

const countsSchema = z.object({
  total: z.number().int().nonnegative(),
  paid: z.number().int().nonnegative(),
  organic: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
})

export const referralAssessmentSchema = z.object({
  scope: z.object({
    project: z.string(),
    sourceId: z.string().nullable(),
    attribution: z.literal('project-source-only'),
    unavailableDimensions: z.array(z.enum(['property', 'target', 'market'])),
  }),
  window: z.object({ startDate: calendarDateSchema, endDate: calendarDateSchema, timeZone: z.literal('UTC') }),
  rule: z.object({
    version: z.literal('hourly-normalized-path-v1'),
    burstThreshold: z.number().int().positive(),
    ratioThreshold: z.number().positive(),
    calibration: z.enum(['uncalibrated-default', 'request-override']),
    grouping: z.array(z.string()),
    confirmsAutomation: z.literal(false),
  }),
  totals: z.object({
    raw: countsSchema,
    redirects: countsSchema,
    subresources: countsSchema,
    countable: countsSchema,
    suspected: countsSchema,
    adjustedEstimate: countsSchema,
  }),
  bursts: z.array(z.object({
    sourceId: z.string(), product: z.string(), landingPathNormalized: z.string(), tsHour: z.string(), counts: countsSchema,
  })),
  evidence: z.object({ total: z.number().int().nonnegative(), returned: z.number().int().nonnegative(), truncated: z.boolean() }),
  comparison: z.object({
    status: z.literal('unavailable'),
    serverCountable: z.number().int().nonnegative(),
    serverObservation: z.enum(['missing', 'observed-zero', 'observed-positive']),
    gaSessions: z.number().int().nonnegative().nullable(),
    gaObservation: z.enum(['missing', 'observed-zero', 'observed-positive']),
    /** Descriptive quotient only. Not a matched, coverage-complete comparison. */
    observedRatio: z.number().nonnegative().nullable(),
    observedRatioAboveThreshold: z.boolean().nullable(),
    ratio: z.null(),
    reasons: z.array(z.string()),
    gaScope: z.literal('project'),
  }),
  caveats: z.array(z.string()),
})
export type ReferralAssessment = z.infer<typeof referralAssessmentSchema>
