import { z } from 'zod'
import { citationStateSchema } from './run.js'

export const discoveryBucketSchema = z.enum(['cited', 'aspirational', 'wasted-surface'])
export type DiscoveryBucket = z.infer<typeof discoveryBucketSchema>
export const DiscoveryBuckets = discoveryBucketSchema.enum

export const discoverySessionStatusSchema = z.enum(['queued', 'seeding', 'probing', 'completed', 'failed'])
export type DiscoverySessionStatus = z.infer<typeof discoverySessionStatusSchema>
export const DiscoverySessionStatuses = discoverySessionStatusSchema.enum

export const discoveryCompetitorMapEntrySchema = z.object({
  domain: z.string().min(1),
  hits: z.number().int().positive(),
})
export type DiscoveryCompetitorMapEntry = z.infer<typeof discoveryCompetitorMapEntrySchema>

export const discoveryProbeDtoSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  projectId: z.string(),
  query: z.string(),
  bucket: discoveryBucketSchema.nullable().default(null),
  citationState: citationStateSchema,
  citedDomains: z.array(z.string()).default([]),
  createdAt: z.string(),
})
export type DiscoveryProbeDto = z.infer<typeof discoveryProbeDtoSchema>

export const discoverySessionDtoSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  status: discoverySessionStatusSchema,
  icpDescription: z.string().nullable().optional(),
  seedProvider: z.string().nullable().optional(),
  seedCountRaw: z.number().int().nullable().optional(),
  seedCount: z.number().int().nullable().optional(),
  dedupThreshold: z.number().nullable().optional(),
  probeCount: z.number().int().nullable().optional(),
  citedCount: z.number().int().nullable().default(null),
  aspirationalCount: z.number().int().nullable().default(null),
  wastedCount: z.number().int().nullable().default(null),
  competitorMap: z.array(discoveryCompetitorMapEntrySchema).default([]),
  error: z.string().nullable().optional(),
  startedAt: z.string().nullable().optional(),
  finishedAt: z.string().nullable().optional(),
  createdAt: z.string(),
})
export type DiscoverySessionDto = z.infer<typeof discoverySessionDtoSchema>

export const discoverySessionDetailDtoSchema = discoverySessionDtoSchema.extend({
  probes: z.array(discoveryProbeDtoSchema).default([]),
})
export type DiscoverySessionDetailDto = z.infer<typeof discoverySessionDetailDtoSchema>

/**
 * Per-session probe budget ceiling. Spec §9 caps per-session at 100 by default
 * and 500 absolute; the contract enforces the absolute cap here so a bad input
 * cannot burn through quota before the service-layer guard kicks in.
 */
export const DISCOVERY_MAX_PROBES_CAP = 500

export const discoveryRunRequestSchema = z.object({
  icpDescription: z.string().min(1).optional(),
  dedupThreshold: z.number().min(0).max(1).optional(),
  maxProbes: z.number().int().positive().max(DISCOVERY_MAX_PROBES_CAP).optional(),
})
export type DiscoveryRunRequest = z.infer<typeof discoveryRunRequestSchema>

/**
 * `queries.provenance` / `competitors.provenance` value vocabulary.
 *
 * - `'cli'` — operator-entered via `canonry query add` / `competitor add` (or
 *   the v55 backfill for pre-discovery rows).
 * - `'discovery:<sessionId>'` — promoted out of a discovery session (PR 2 +).
 *
 * NULL means a post-v55 row whose writer forgot to set provenance; treat as a
 * bug rather than as a meaningful state.
 */
export const queryProvenanceSchema = z.union([
  z.literal('cli'),
  z.string().regex(/^discovery:.+$/),
])
export type QueryProvenance = z.infer<typeof queryProvenanceSchema>
