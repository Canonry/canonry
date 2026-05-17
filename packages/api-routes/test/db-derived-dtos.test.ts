import { describe, expect, it } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import {
  notifications,
  projects,
  runs,
  schedules,
} from '@ainyc/canonry-db'
import {
  notificationRowSchema,
  projectRowSchema,
  runRowSchema,
  scheduleRowSchema,
} from '../src/db-derived-dtos.js'

/**
 * Tests for the `drizzle-zod`-derived row schemas in `db-derived-dtos.ts`.
 *
 * Two invariants per table:
 *
 * 1. **Field coverage.** `Object.keys(derivedSchema.shape)` must equal
 *    `Object.keys(getTableColumns(table))` — every DB column maps to a
 *    derived-schema field, and there's no derived-schema field that
 *    doesn't correspond to a column. This is stricter than the
 *    `db-dto-coverage.test.ts` check (which only asserts DB columns are
 *    accounted for in the consumer-facing DTO or an allowlist) — here we
 *    catch schema additions BEFORE a hand-rolled DTO has a chance to
 *    drift.
 *
 * 2. **Round-trip parse.** A representative typed row parses through the
 *    derived schema without losing or transforming any field. Refinements
 *    enforce enums (`configSource`, `runKind`, etc.) and JSON inner
 *    shapes (`locations`, `config`, `providers`) — a refinement that
 *    drops or mistypes a value surfaces here.
 *
 * Why DB → derived rather than derived → DTO compat: compat between
 * the derived schema and the hand-rolled DTO is checked indirectly by
 * the existing `composites.test.ts` end-to-end tests that round-trip
 * through `formatX(row): SomeDto`. This file focuses on the schema/
 * derived seam; the DTO/handler seam is already covered.
 */

const ENTRIES = [
  { name: 'projects', table: projects, schema: projectRowSchema },
  { name: 'runs', table: runs, schema: runRowSchema },
  { name: 'schedules', table: schedules, schema: scheduleRowSchema },
  { name: 'notifications', table: notifications, schema: notificationRowSchema },
] as const

describe('drizzle-zod derived row schemas', () => {
  for (const entry of ENTRIES) {
    it(`${entry.name}: derived schema field set equals DB column set`, () => {
      const dbColumns = Object.keys(getTableColumns(entry.table)).sort()
      const derivedFields = Object.keys(entry.schema.shape).sort()
      expect(derivedFields, `${entry.name} drizzle-zod derived fields drifted from the table — re-derive or update refinements`).toEqual(dbColumns)
    })
  }

  it('projectRowSchema round-trips a representative row', () => {
    const row = {
      id: 'p_1',
      name: 'acme',
      displayName: 'Acme Inc.',
      canonicalDomain: 'acme.com',
      ownedDomains: ['acme.com', 'acme.dev'],
      aliases: ['acme', 'ACME'],
      country: 'US',
      language: 'en',
      tags: ['saas', 'b2b'],
      labels: { team: 'growth', tier: 'enterprise' },
      providers: ['gemini', 'openai'],
      locations: [{ label: 'us-east', city: 'New York', region: 'NY', country: 'US' }],
      defaultLocation: 'us-east',
      autoExtractBacklinks: true,
      configSource: 'cli',
      configRevision: 3,
      icpDescription: 'Mid-market B2B SaaS',
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-17T00:00:00Z',
    }
    const parsed = projectRowSchema.parse(row)
    expect(parsed).toEqual(row)
  })

  it('projectRowSchema rejects bad configSource', () => {
    const result = projectRowSchema.safeParse({
      id: 'p_1',
      name: 'acme',
      displayName: 'Acme',
      canonicalDomain: 'acme.com',
      ownedDomains: [],
      aliases: [],
      country: 'US',
      language: 'en',
      tags: [],
      labels: {},
      providers: [],
      locations: [],
      defaultLocation: null,
      autoExtractBacklinks: false,
      configSource: 'invalid-source',
      configRevision: 1,
      icpDescription: null,
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-17T00:00:00Z',
    })
    expect(result.success).toBe(false)
  })

  it('runRowSchema round-trips a representative row with null queries', () => {
    const row = {
      id: 'r_1',
      projectId: 'p_1',
      kind: 'answer-visibility' as const,
      status: 'completed' as const,
      trigger: 'manual' as const,
      location: null,
      queries: null,
      sourceId: null,
      startedAt: '2026-05-17T00:00:00Z',
      finishedAt: '2026-05-17T00:01:00Z',
      error: null,
      createdAt: '2026-05-17T00:00:00Z',
    }
    const parsed = runRowSchema.parse(row)
    expect(parsed).toEqual(row)
  })

  it('runRowSchema round-trips a representative row with typed queries array', () => {
    const row = {
      id: 'r_2',
      projectId: 'p_1',
      kind: 'answer-visibility' as const,
      status: 'completed' as const,
      trigger: 'scheduled' as const,
      location: 'us-east',
      queries: ['what is acme?', 'acme reviews'],
      sourceId: null,
      startedAt: '2026-05-17T00:00:00Z',
      finishedAt: '2026-05-17T00:01:00Z',
      error: null,
      createdAt: '2026-05-17T00:00:00Z',
    }
    const parsed = runRowSchema.parse(row)
    expect(parsed).toEqual(row)
  })

  it('scheduleRowSchema round-trips with enabled=true and typed providers', () => {
    const row = {
      id: 's_1',
      projectId: 'p_1',
      kind: 'answer-visibility' as const,
      cronExpr: '0 8 * * *',
      preset: 'daily',
      timezone: 'America/Los_Angeles',
      enabled: true,
      providers: ['gemini', 'openai'] as const,
      sourceId: null,
      lastRunAt: '2026-05-16T08:00:00Z',
      nextRunAt: '2026-05-17T08:00:00Z',
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-17T00:00:00Z',
    }
    const parsed = scheduleRowSchema.parse(row)
    expect(parsed).toEqual(row)
  })

  it('notificationRowSchema round-trips with typed config object', () => {
    const row = {
      id: 'n_1',
      projectId: 'p_1',
      channel: 'webhook' as const,
      config: {
        url: 'https://example.com/hook',
        events: ['run.completed', 'insight.critical'],
      },
      webhookSecret: 'whsec_xyz',
      enabled: true,
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-17T00:00:00Z',
    }
    const parsed = notificationRowSchema.parse(row)
    expect(parsed).toEqual(row)
  })

  it('notificationRowSchema rejects config without url', () => {
    const result = notificationRowSchema.safeParse({
      id: 'n_1',
      projectId: 'p_1',
      channel: 'webhook',
      config: { events: ['run.completed'] }, // missing url
      webhookSecret: null,
      enabled: true,
      createdAt: '2026-05-01T00:00:00Z',
      updatedAt: '2026-05-17T00:00:00Z',
    })
    expect(result.success).toBe(false)
  })
})
