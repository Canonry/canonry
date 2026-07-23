import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createClient,
  gaAcquisitionDaily,
  gaLeadEventsDaily,
  gaMeasurementSyncStates,
  gscDailyTotals,
  gscQueryDailyTotals,
  migrate,
  projects,
} from '@ainyc/canonry-db'
import { buildGaMeasurementAnalysis } from '../src/ga-measurement-analysis.js'

const NOW = '2026-07-23T12:00:00.000Z'

describe('GA measurement analysis review regressions', () => {
  const temporaryDirectories: string[] = []

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('shares the GA cohort timeline with sparse leads and ranks detail without truncating channels', () => {
    const temporaryDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'canonry-ga-analysis-review-'),
    )
    temporaryDirectories.push(temporaryDirectory)
    const db = createClient(path.join(temporaryDirectory, 'test.db'))
    migrate(db)
    const projectId = crypto.randomUUID()
    db.insert(projects).values({
      id: projectId,
      name: 'review-project',
      displayName: 'Review Project',
      canonicalDomain: 'example.com',
      ownedDomains: [],
      aliases: [],
      country: 'US',
      language: 'en',
      measurement: {
        marketingHosts: [],
        brandTerms: [],
        leadEventNames: ['generate_lead'],
      },
      createdAt: NOW,
      updatedAt: NOW,
    }).run()

    db.insert(gaAcquisitionDaily).values([
      {
        id: crypto.randomUUID(),
        projectId,
        date: '2026-07-22',
        channelGroup: 'Organic Search',
        source: 'google',
        medium: 'organic',
        hostName: 'example.com',
        landingPage: '/a-low',
        landingPageNormalized: '/a-low',
        sessions: 1,
        syncedAt: NOW,
        createdAt: NOW,
      },
      {
        id: crypto.randomUUID(),
        projectId,
        date: '2026-07-22',
        channelGroup: 'Paid Search',
        source: 'google',
        medium: 'cpc',
        hostName: 'example.com',
        landingPage: '/z-high',
        landingPageNormalized: '/z-high',
        sessions: 10,
        syncedAt: NOW,
        createdAt: NOW,
      },
    ]).run()
    db.insert(gaLeadEventsDaily).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-06-17',
      eventName: 'generate_lead',
      channelGroup: 'Organic Search',
      source: 'google',
      medium: 'organic',
      hostName: 'example.com',
      landingPage: '/old-lead',
      landingPageNormalized: '/old-lead',
      attributionScope: 'landing-page',
      eventCount: 4,
      syncedAt: NOW,
      createdAt: NOW,
    }).run()
    db.insert(gaMeasurementSyncStates).values({
      projectId,
      acquisitionStatus: 'ready',
      acquisitionSyncedAt: NOW,
      leadStatus: 'ready',
      leadSyncedAt: NOW,
      leadAttributionScope: 'landing-page',
      updatedAt: NOW,
    }).run()

    db.insert(gscDailyTotals).values({
      id: crypto.randomUUID(),
      projectId,
      date: '2026-07-20',
      clicks: 20,
      impressions: 200,
      position: '3',
      createdAt: NOW,
    }).run()
    db.insert(gscQueryDailyTotals).values([
      {
        id: crypto.randomUUID(),
        projectId,
        date: '2026-07-20',
        query: 'a low-volume query',
        clicks: 1,
        impressions: 10,
        position: '4',
        syncedAt: NOW,
        createdAt: NOW,
      },
      {
        id: crypto.randomUUID(),
        projectId,
        date: '2026-07-20',
        query: 'z high-volume query',
        clicks: 9,
        impressions: 90,
        position: '2',
        syncedAt: NOW,
        createdAt: NOW,
      },
    ]).run()

    const result = buildGaMeasurementAnalysis(db, 'review-project', {
      window: '60d',
      limit: 1,
    })

    expect(result.leads.periods).toEqual([
      expect.objectContaining({
        label: 'previous',
        startDate: '2026-05-24',
        endDate: '2026-06-22',
        eventCount: 4,
      }),
      expect.objectContaining({
        label: 'latest',
        startDate: '2026-06-23',
        endDate: '2026-07-22',
        eventCount: 0,
      }),
    ])
    expect(result.acquisition.channels.map(row => row.channelGroup)).toEqual([
      'Paid Search',
      'Organic Search',
    ])
    expect(result.acquisition.pages).toEqual([
      expect.objectContaining({ landingPage: '/z-high' }),
    ])
    expect(result.searchDemand.queries).toEqual([
      expect.objectContaining({ query: 'z high-volume query' }),
    ])
  })
})
