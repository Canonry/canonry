import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentJourneyEvents,
  aiUserFetchEventsHourly,
  createClient,
  crawlerEventsHourly,
  migrate,
  projects,
  rawEventSamples,
  trafficSources,
  unrecognizedAgentEventsHourly,
} from '@canonry/canonry-db'
import { reclassifyStoredTraffic } from '../src/traffic-reclassify.js'

const NOW = '2026-11-01T06:00:00.000Z'
const SEARCHBOT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)'
const EXA = 'Mozilla/5.0 (compatible; ExaSearchBot/1.0; +https://crawler.exa.ai/)'
const ROWS = 120

/** Every table the pass pages through. */
const PAGED_TABLES = ['agent_journey_events', 'ai_user_fetch_events_hourly', 'crawler_events_hourly', 'raw_event_samples', 'unrecognized_agent_events_hourly']

describe('stored traffic pass query plans', () => {
  let directory: string
  let db: ReturnType<typeof createClient>

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'canonry-reclassify-plan-'))
    db = createClient(path.join(directory, 'canonry.db'))
    migrate(db)
    db.transaction((tx) => {
      for (const id of ['one', 'two']) {
        tx.insert(projects).values({
          id, name: `project-${id}`, displayName: id, canonicalDomain: `${id}.example`,
          country: 'US', language: 'en', createdAt: NOW, updatedAt: NOW,
        }).run()
        tx.insert(trafficSources).values({ id: `source-${id}`, projectId: id, sourceType: 'cloudflare', displayName: id, status: 'connected', createdAt: NOW, updatedAt: NOW }).run()
      }
      // Work for every step in both projects: misfiled crawler hours and
      // samples, so the pass reads their rows as well as their counts.
      for (let index = 0; index < ROWS; index++) {
        const projectId = index % 2 === 0 ? 'one' : 'two'
        const owner = { projectId, sourceId: `source-${projectId}` }
        const tsHour = new Date(Date.parse('2026-10-01T00:00:00.000Z') + index * 3_600_000).toISOString()
        tx.insert(crawlerEventsHourly).values({
          ...owner, tsHour, botId: 'anthropic-claudebot', operator: 'Anthropic', verificationStatus: 'claimed_unverified',
          pathNormalized: `/page-${index}`, status: 200, hits: 1, sampledUserAgent: SEARCHBOT, createdAt: NOW, updatedAt: NOW,
        }).run()
        tx.insert(rawEventSamples).values({
          ...owner, id: `crawler-${index}`, ts: tsHour, eventType: 'crawler', userAgent: SEARCHBOT, pathNormalized: `/page-${index}`, status: 200,
          classifierDetailsJson: { crawler: { botId: 'anthropic-claudebot', operator: 'Anthropic', product: 'ClaudeBot', purpose: 'training', verificationStatus: 'claimed_unverified' }, aiUserFetch: null, aiReferral: null },
          createdAt: tsHour,
        }).run()
        tx.insert(rawEventSamples).values({
          ...owner, id: `unknown-${index}`, ts: tsHour, eventType: 'unknown', userAgent: EXA, pathNormalized: `/page-${index}`, status: 200,
          classifierDetailsJson: { crawler: null, aiUserFetch: null, aiReferral: null }, createdAt: tsHour,
        }).run()
        tx.insert(unrecognizedAgentEventsHourly).values({
          ...owner, tsHour, agentName: 'exasearchbot', hits: 1, sampledUserAgent: EXA, sampledPath: '/', createdAt: NOW, updatedAt: NOW,
        }).run()
        tx.insert(aiUserFetchEventsHourly).values({
          ...owner, tsHour, botId: 'claude-user', operator: 'Anthropic', verificationStatus: 'claimed_unverified',
          pathNormalized: index % 10 === 0 ? '/.env' : `/page-${index}`, status: 200, hits: 1, createdAt: NOW, updatedAt: NOW,
        }).run()
        tx.insert(agentJourneyEvents).values({
          ...owner, id: `request-${index}`, sourceEventId: `event-${index}`, ts: tsHour, correlationKey: `client-${index % 7}`, correlationBasis: 'ip-ua',
          agentId: index % 3 === 0 ? 'claude-agent' : 'claude-user', operator: 'Anthropic', product: 'Claude', verificationStatus: 'claimed_unverified',
          verificationManifest: null, trust: 'unknown', trustReasons: [], host: `${projectId}.example`,
          path: index % 3 === 0 ? '/_next/static/app.js' : `/page-${index}`, method: 'GET', status: 200, latencyMs: null, createdAt: NOW,
        }).run()
      }
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    db.$client.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  function planOf(query: string): string {
    const parameters = Array.from({ length: query.split('?').length - 1 }, () => null)
    return db.$client.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...parameters)
      .map(row => (row as { detail: string }).detail).join(' | ')
  }

  it('walks every table by rowid without sorting, scoped to a project or not', async () => {
    const prepare = vi.spyOn(db.$client, 'prepare')

    const scoped = await reclassifyStoredTraffic(db, { now: NOW, projectIds: ['one'], dryRun: true })
    const scopedQueries = prepare.mock.calls.map(([query]) => query)
    prepare.mockClear()
    const unscoped = await reclassifyStoredTraffic(db, { now: NOW, dryRun: true })
    const unscopedQueries = prepare.mock.calls.map(([query]) => query)
    prepare.mockRestore()

    // Every step found its work, in one project or both.
    expect(scoped.crawlers).toMatchObject({ examined: ROWS / 2, moved: ROWS / 2, samplesRelabeled: ROWS / 2 })
    expect(unscoped.crawlers).toMatchObject({ examined: ROWS, moved: ROWS, samplesRelabeled: ROWS })
    expect(unscoped).toMatchObject({
      samples: { examined: ROWS },
      unrecognized: { examined: ROWS },
      agentHits: { examined: ROWS, moved: ROWS / 10 },
      agentRequests: { examined: ROWS, pageResources: ROWS / 3 },
    })
    for (const queries of [scopedQueries, unscopedQueries]) {
      const pageReads = [...new Set(queries.filter(query => query.startsWith('select') && query.includes('rowid >')))]
      expect([...new Set(pageReads.map(query => /from "(\w+)"/.exec(query)?.[1]))].sort()).toEqual(PAGED_TABLES)
      for (const read of pageReads) {
        const plan = planOf(read)
        // A plain project filter makes SQLite pick a project index and sort
        // that project's rows for every page; the pass walks rowids instead.
        expect(plan, read).toContain('rowid>? AND rowid<?')
        expect(plan, read).not.toContain('TEMP B-TREE FOR ORDER BY')
      }
    }
  })
})
