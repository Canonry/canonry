import { z } from 'zod'
import { competitorEntrySchema, competitorAliasChangeSchema, competitorAliasRejectionSchema, competitorAutoAliasDropSchema } from './competitor-aliases.js'
import { percent } from './ratio-unit.js'
import { visibilityStatsShareOfVoiceSchema } from './visibility-stats.js'

export const competitorChangeKindSchema = z.enum(['add', 'remove', 'replace', 'aliases'])
export type CompetitorChangeKind = z.infer<typeof competitorChangeKindSchema>
export const CompetitorChangeKinds = competitorChangeKindSchema.enum

export const competitorShareImpactCaveatSchema = z.enum(['basis-changed', 'auto-alias-rescan-pending', 'no-latest-sweep', 'pooled'])
export type CompetitorShareImpactCaveat = z.infer<typeof competitorShareImpactCaveatSchema>
export const CompetitorShareImpactCaveats = competitorShareImpactCaveatSchema.enum

export const competitorChangePreviewRequestSchema = z.discriminatedUnion('change', [
  z.object({ change: z.literal(CompetitorChangeKinds.add), competitors: z.array(competitorEntrySchema).min(1) }).strict(),
  z.object({ change: z.literal(CompetitorChangeKinds.remove), competitors: z.array(z.string().trim().min(1)).min(1) }).strict(),
  z.object({ change: z.literal(CompetitorChangeKinds.replace), competitors: z.array(z.string().trim().min(1)) }).strict(),
  z.object({ change: z.literal(CompetitorChangeKinds.aliases), domain: z.string().trim().min(1), aliases: z.array(z.string().trim().min(1)), mode: z.enum(['set', 'add']) }).strict(),
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
  caveats: z.array(competitorShareImpactCaveatSchema),
}).strict()
export type CompetitorShareImpact = z.infer<typeof competitorShareImpactSchema>

export const competitorBulkAddPreviewSchema = z.object({
  limit: z.number().int().positive(),
  count: z.number().int().nonnegative(),
  acknowledgementRequired: z.boolean(),
}).strict()
export type CompetitorBulkAddPreview = z.infer<typeof competitorBulkAddPreviewSchema>

export const competitorChangePreviewResponseSchema = z.object({
  project: z.string().trim().min(1),
  change: competitorChangeKindSchema,
  plan: z.object({
    added: z.array(z.string()),
    alreadyTracked: z.array(z.string()),
    removed: z.array(z.string()),
    aliasChanges: z.array(competitorAliasChangeSchema),
    droppedAliases: z.array(competitorAliasRejectionSchema),
    autoAliasChanges: z.array(competitorAliasChangeSchema),
    droppedAutoAliases: z.array(competitorAutoAliasDropSchema),
  }).strict(),
  bulkAdd: competitorBulkAddPreviewSchema,
  impact: competitorShareImpactSchema,
}).strict()
export type CompetitorChangePreviewResponse = z.infer<typeof competitorChangePreviewResponseSchema>
