import { z } from 'zod'
import { gaMeasurementAnalysisDtoSchema } from './measurement.js'

export const organicEvidencePeriodSchema = z.union([z.literal(60), z.literal(90)])
export type OrganicEvidencePeriodDays = z.infer<typeof organicEvidencePeriodSchema>

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
  /** Latest date shared by GSC and GA4 when both exist. */
  asOfDate: z.string().nullable(),
  cohorts: z.array(cohortSchema),
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
    blogOrganicSessions: z.number().int().nonnegative(),
    cohorts: z.array(sessionCohortSchema),
  }).nullable(),
  gaAiReferrals: z.object({
    paidSessions: z.number().int().nonnegative(),
    organicSessions: z.number().int().nonnegative(),
  }).nullable(),
  /** `/blog` and descendants, reconciled without combining unlike units. */
  blog: z.object({
    pathRule: z.literal('/blog and descendants'),
    gsc: z.object({ cohorts: z.array(searchCohortSchema) }).nullable(),
    ga4: z.object({ cohorts: z.array(sessionCohortSchema) }).nullable(),
    server: z.object({
      crawlerHits: crawlerCountsSchema,
      userFetchHits: crawlerCountsSchema,
      referralSessions: referralCountsSchema,
    }).nullable(),
  }),
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
