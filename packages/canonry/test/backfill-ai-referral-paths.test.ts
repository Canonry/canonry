import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createClient,
  gaAiReferrals,
  migrate,
  projects,
} from '@ainyc/canonry-db'
import { eq } from 'drizzle-orm'
import { backfillAiReferralPaths } from '../src/commands/backfill.js'

describe('backfillAiReferralPaths', () => {
  let tmpDir: string
  let dbPath: string
  let db: ReturnType<typeof createClient>

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-backfill-ai-paths-'))
    dbPath = path.join(tmpDir, 'canonry.db')
    db = createClient(dbPath)
    migrate(db)

    const now = new Date().toISOString()
    db.insert(projects).values({
      id: 'proj_1',
      name: 'test-project',
      displayName: 'Test',
      canonicalDomain: 'example.com',
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    }).run()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function insertReferral(opts: {
    id: string
    projectId?: string
    source?: string
    medium?: string
    sourceDimension?: 'session' | 'first_user' | 'manual_utm'
    landingPage: string
    landingPageNormalized?: string | null
  }) {
    const now = new Date().toISOString()
    db.insert(gaAiReferrals).values({
      id: opts.id,
      projectId: opts.projectId ?? 'proj_1',
      date: '2026-04-29',
      source: opts.source ?? 'chatgpt.com',
      medium: opts.medium ?? 'referral',
      sourceDimension: opts.sourceDimension ?? 'session',
      landingPage: opts.landingPage,
      landingPageNormalized:
        opts.landingPageNormalized === undefined ? null : opts.landingPageNormalized,
      sessions: 1,
      users: 1,
      syncedAt: now,
    }).run()
  }

  function readNormalized(id: string): string | null | undefined {
    const [row] = db
      .select({ landingPageNormalized: gaAiReferrals.landingPageNormalized })
      .from(gaAiReferrals)
      .where(eq(gaAiReferrals.id, id))
      .all()
    return row?.landingPageNormalized
  }

  it('populates landing_page_normalized for rows where it is null', () => {
    insertReferral({ id: 'r1', source: 'chatgpt.com', landingPage: '/pricing?utm_source=chatgpt.com' })
    insertReferral({ id: 'r2', source: 'claude.ai', landingPage: '/about/' })
    insertReferral({ id: 'r3', source: 'perplexity.ai', landingPage: '/' })
    insertReferral({ id: 'r4', source: 'gemini.google.com', landingPage: '(not set)' })

    const result = backfillAiReferralPaths(db)
    expect(result.examined).toBe(4)
    expect(result.updated).toBe(3)
    expect(result.unchanged).toBe(1)

    expect(readNormalized('r1')).toBe('/pricing')
    expect(readNormalized('r2')).toBe('/about')
    expect(readNormalized('r3')).toBe('/')
    expect(readNormalized('r4')).toBeNull()
  })

  it('repairs stale normalized values', () => {
    insertReferral({
      id: 'r_stale',
      source: 'chatgpt.com',
      landingPage: '/about/',
      landingPageNormalized: '/sentinel',
    })
    insertReferral({ id: 'r_null', source: 'claude.ai', landingPage: '/about/' })

    backfillAiReferralPaths(db)

    expect(readNormalized('r_stale')).toBe('/about')
    expect(readNormalized('r_null')).toBe('/about')
  })

  it('handles multiple landing pages under the same source × dimension', () => {
    insertReferral({ id: 'p1', source: 'chatgpt.com', sourceDimension: 'session', landingPage: '/pricing' })
    insertReferral({ id: 'p2', source: 'chatgpt.com', sourceDimension: 'first_user', landingPage: '/guide/' })
    insertReferral({ id: 'p3', source: 'claude.ai', sourceDimension: 'session', landingPage: '/comparison/' })

    const result = backfillAiReferralPaths(db)
    expect(result.examined).toBe(3)
    expect(result.updated).toBe(3)
    expect(readNormalized('p1')).toBe('/pricing')
    expect(readNormalized('p2')).toBe('/guide')
    expect(readNormalized('p3')).toBe('/comparison')
  })

  it('is idempotent — second run touches nothing', () => {
    insertReferral({ id: 'r1', source: 'chatgpt.com', landingPage: '/about/' })
    const first = backfillAiReferralPaths(db)
    expect(first.updated).toBe(1)

    const second = backfillAiReferralPaths(db)
    expect(second.updated).toBe(0)
    expect(second.examined).toBe(1)
    expect(second.unchanged).toBe(1)
  })

  it('scopes to a project when projectId is provided', () => {
    const now = new Date().toISOString()
    db.insert(projects).values({
      id: 'proj_2',
      name: 'other-project',
      displayName: 'Other',
      canonicalDomain: 'other.com',
      country: 'US',
      language: 'en',
      createdAt: now,
      updatedAt: now,
    }).run()
    insertReferral({ id: 'r_other', projectId: 'proj_2', source: 'chatgpt.com', landingPage: '/?fbclid=skip' })
    insertReferral({ id: 'r_in_scope', source: 'claude.ai', landingPage: '/?fbclid=touch' })

    backfillAiReferralPaths(db, { projectId: 'proj_1' })

    expect(readNormalized('r_in_scope')).toBe('/')
    expect(readNormalized('r_other')).toBeNull()
  })
})
