import { z } from 'zod'
import { competitorEntrySchema } from './competitor-aliases.js'
import { percent } from './ratio-unit.js'
import { visibilityStatsShareOfVoiceSchema } from './visibility-stats.js'

export const competitorChangePreviewRequestSchema = z.discriminatedUnion('change', [
  z.object({ change: z.literal('add'), competitors: z.array(competitorEntrySchema).min(1) }).strict(),
  z.object({ change: z.literal('remove'), competitors: z.array(z.string().trim().min(1)).min(1) }).strict(),
  z.object({ change: z.literal('replace'), competitors: z.array(competitorEntrySchema) }).strict(),
  z.object({ change: z.literal('aliases'), domain: z.string().trim().min(1), aliases: z.array(z.string().trim().min(1)), mode: z.enum(['set', 'add']) }).strict(),
])
export type CompetitorChangePreviewRequest = z.infer<typeof competitorChangePreviewRequestSchema>

export const competitorShareImpactSchema = z.object({
  instrument: z.literal('competitor-landscape'),
  queryClass: z.enum(['non-brand', 'pooled']),
  scope: z.enum(['project', 'all-markets']),
  runIds: z.array(z.string()),
  runCount: z.number().int().nonnegative(),
  sweepAt: z.string().datetime().nullable(),
  before: visibilityStatsShareOfVoiceSchema,
  after: visibilityStatsShareOfVoiceSchema,
  deltaPercent: percent().nullable(),
  restatesHistory: z.literal(true),
  caveats: z.array(z.enum(['basis-changed', 'auto-alias-rescan-pending', 'no-latest-sweep', 'pooled'])),
}).strict()
export type CompetitorShareImpact = z.infer<typeof competitorShareImpactSchema>

export const competitorChangePreviewResponseSchema = z.object({
  project: z.string().trim().min(1),
  change: competitorChangePreviewRequestSchema,
  plan: z.object({
    added: z.array(z.string()),
    alreadyTracked: z.array(z.string()),
    removed: z.array(z.string()),
    aliasChanges: z.array(z.unknown()),
    droppedAliases: z.array(z.unknown()),
    autoAliasChanges: z.array(z.unknown()),
    droppedAutoAliases: z.array(z.unknown()),
  }).strict(),
  impact: competitorShareImpactSchema,
}).strict()
export type CompetitorChangePreviewResponse = z.infer<typeof competitorChangePreviewResponseSchema>
