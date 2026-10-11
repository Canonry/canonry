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

const competitorAliasChangeSchema = z.object({
  domain: z.string(),
  before: z.array(z.string()),
  after: z.array(z.string()),
}).strict()

const competitorAliasRejectionSchema = z.object({
  domain: z.string(),
  alias: z.string(),
  reason: z.enum(['too-long', 'too-short', 'project-brand', 'other-competitor', 'market-competitor', 'claimed-by-alias']),
  conflictsWith: z.string().optional(),
  conflictingName: z.string().optional(),
  markets: z.array(z.string()).optional(),
  supersededRevision: z.number().int().optional(),
}).strict()

const competitorAutoAliasDropSchema = z.object({
  domain: z.string(),
  alias: z.string(),
  reason: z.enum(['too-long', 'too-short', 'blocked', 'already-matched', 'subsumed', 'project-brand', 'other-competitor', 'over-limit']),
  stored: z.boolean(),
  conflictsWith: z.string().optional(),
  conflictingName: z.string().optional(),
}).strict()

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
  change: z.enum(['add', 'remove', 'replace', 'aliases']),
  plan: z.object({
    added: z.array(z.string()),
    alreadyTracked: z.array(z.string()),
    removed: z.array(z.string()),
    aliasChanges: z.array(competitorAliasChangeSchema),
    droppedAliases: z.array(competitorAliasRejectionSchema),
    autoAliasChanges: z.array(competitorAliasChangeSchema),
    droppedAutoAliases: z.array(competitorAutoAliasDropSchema),
  }).strict(),
  impact: competitorShareImpactSchema,
}).strict()
export type CompetitorChangePreviewResponse = z.infer<typeof competitorChangePreviewResponseSchema>
