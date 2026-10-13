import { WINDOW_SETS, parseWindowIn, windowDayValues, windowDays } from './time-window.js'
import { z } from 'zod'
import { gaMeasurementAnalysisDtoSchema } from './measurement.js'

export const organicEvidencePeriodSchema = z.union(windowDayValues(WINDOW_SETS.organicEvidence).map(value => z.literal(value)))
export type OrganicEvidencePeriodDays = z.infer<typeof organicEvidencePeriodSchema>

export function parseOrganicEvidencePeriod(value?: string | number): OrganicEvidencePeriodDays {
  return windowDays(parseWindowIn(value, WINDOW_SETS.organicEvidence, { field: 'period', fallback: '90d' }))
}

const cohortNameSchema = z.enum(['earliest', 'middle', 'prior', 'latest'])
const countSchema = z.object({
  clicks: z.number().int().nonnegative(),
  impressions: z.number().int().nonnegative(),
})
const cohortSchema = z.object({
  name: cohortNameSchema,
  startDate: z.string(),
  endDate: z.string(),
})
const searchCohortSchema = cohortSchema.extend({ totals: countSchema })
const sessionCohortSchema = cohortSchema.extend({
  organicSessions: z.number().int().nonnegative(),
})
const sourceCoverageSchema = z.object({
  startDate: z.string(),
  endDate: z.string(),
  observedDays: z.number().int().nonnegative(),
})
const crawlerCountsSchema = z.object({
  verified: z.number().int().nonnegative(),
  claimedUnverified: z.number().int().nonnegative(),
  unknownAiLike: z.number().int().nonnegative(),
})
const referralCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  paid: z.number().int().nonnegative(),
  organic: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
})

export const organicEvidenceDtoSchema = z.object({
  contractVersion: z.literal('organic-evidence/v1'),
  periodDays: organicEvidencePeriodSchema,
  /** Latest headline evidence date, preferring the GSC property date when available. */
  asOfDate: z.string().nullable(),
  coverage: z.object({
    gsc: z.boolean(),
    ga4: z.boolean(),
    server: z.boolean(),
    visibility: z.boolean(),
  }),
  sourceCoverage: z.object({
    gsc: sourceCoverageSchema.nullable(),
    ga4: sourceCoverageSchema.nullable(),
    server: sourceCoverageSchema.nullable(),
    visibility: z.object({ completedAt: z.string(), ageDays: z.number().nonnegative() }).nullable(),
  }),
  gsc: z.object({
    propertyTotals: countSchema,
    namedBrand: countSchema,
    namedNonBrand: countSchema,
    suppressedOrUnreportedResidual: countSchema,
    cohorts: z.array(searchCohortSchema),
  }).nullable(),
  ga4: z.object({
    organicSessions: z.number().int().nonnegative(),
    cohorts: z.array(sessionCohortSchema),
  }).nullable(),
  gaAiReferrals: z.object({
    paidSessions: z.number().int().nonnegative(),
    organicSessions: z.number().int().nonnegative(),
  }).nullable(),
  server: z.object({
    crawlerHits: crawlerCountsSchema,
    userFetchHits: crawlerCountsSchema,
    referralSessions: referralCountsSchema,
  }).nullable(),
  visibility: z.object({
    runId: z.string(),
    completedAt: z.string(),
    ageDays: z.number().nonnegative(),
    answerPairs: z.number().int().nonnegative(),
    mentionedPairs: z.number().int().nonnegative(),
    citedPairs: z.number().int().nonnegative(),
  }).nullable(),
  measurement: gaMeasurementAnalysisDtoSchema,
  pages: z.array(z.object({
    path: z.string(),
    gsc: countSchema,
    ga4OrganicSessions: z.number().int().nonnegative(),
    server: z.object({
      crawlerHits: crawlerCountsSchema,
      userFetchHits: crawlerCountsSchema,
      referralSessions: referralCountsSchema,
    }),
  })),
  findings: z.array(z.object({
    tone: z.enum(['positive', 'caution', 'neutral']),
    title: z.string(),
    detail: z.string(),
  })),
  limitations: z.array(z.object({ code: z.string(), detail: z.string() })),
})

export type OrganicEvidenceDto = z.infer<typeof organicEvidenceDtoSchema>
