/**
 * Guest report DTOs — the anonymous /aero owner-view flow.
 *
 * Visitors drop a domain at `/aero`, get a free first report (audit + AI
 * visibility sweep), then optionally sign up + claim it into their
 * workspace. These DTOs describe the four endpoints that surface the
 * report state:
 *
 *   POST /api/v1/guest/report                  → guestReportCreateResponseSchema
 *   GET  /api/v1/guest/report/:id              → guestReportDtoSchema
 *   GET  /api/v1/guest/report/:id/stream       → SSE (no JSON DTO)
 *   POST /api/v1/guest/report/:id/claim        → guestReportClaimResponseSchema
 */

import { z } from 'zod'

export const guestReportStatusSchema = z.enum([
  'pending',
  'auditing',
  'sweeping',
  'completed',
  'failed',
])
export type GuestReportStatus = z.infer<typeof guestReportStatusSchema>

export const guestReportProgressEventSchema = z.object({
  at: z.string(),
  type: z.enum([
    'sitemap-pulled',
    'page-audited',
    'audit-complete',
    'sweep-started',
    'provider-checked',
    'overall-complete',
    'failed',
  ]),
  payload: z.record(z.string(), z.unknown()),
})
export type GuestReportProgressEventDto = z.infer<typeof guestReportProgressEventSchema>

const auditFindingSchema = z.object({
  severity: z.string(),
  title: z.string(),
  url: z.string(),
  pointsLost: z.number(),
})

const proposedPlanItemSchema = z.object({
  label: z.string(),
  pointsImpact: z.number(),
  rationale: z.string(),
})

/**
 * Full guest report row as returned by GET /guest/report/:id. Reflects the
 * `serializeGuestReport` shape in `packages/api-routes/src/guest-report.ts`.
 * The `progressEvents` array doubles as an SSE replay buffer.
 */
export const guestReportDtoSchema = z.object({
  id: z.string(),
  domain: z.string(),
  projectId: z.string(),
  status: guestReportStatusSchema,
  auditScore: z.number().nullable(),
  auditPagesCrawled: z.number(),
  auditFindingsCount: z.number(),
  auditTopFindings: z.array(auditFindingSchema),
  overallScore: z.number().nullable(),
  aiCitedCount: z.number().nullable(),
  aiQueryCount: z.number().nullable(),
  aiMentionedCount: z.number().nullable(),
  topCompetitor: z.string().nullable(),
  topCompetitorCitedCount: z.number().nullable(),
  proposedPlan: z.array(proposedPlanItemSchema),
  progressEvents: z.array(guestReportProgressEventSchema),
  errorMessage: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  claimedAt: z.string().nullable(),
})
export type GuestReportDto = z.infer<typeof guestReportDtoSchema>

/** Slim stub returned by POST /guest/report — just enough to start polling. */
export const guestReportCreateResponseSchema = z.object({
  id: z.string(),
  domain: z.string(),
  status: guestReportStatusSchema,
  expiresAt: z.string(),
})
export type GuestReportCreateResponseDto = z.infer<typeof guestReportCreateResponseSchema>

/**
 * Claim response — returned by POST /guest/report/:id/claim. Either
 * `claimed: true` (just-now claim) or `alreadyClaimed: true` (idempotent
 * re-claim). Both carry the project the report was promoted into.
 */
export const guestReportClaimResponseSchema = z.object({
  claimed: z.literal(true).optional(),
  alreadyClaimed: z.literal(true).optional(),
  projectName: z.string().nullable(),
  projectId: z.string(),
})
export type GuestReportClaimResponseDto = z.infer<typeof guestReportClaimResponseSchema>
