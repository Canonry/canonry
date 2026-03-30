import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Fastify from 'fastify'
import { createClient, migrate } from '@ainyc/canonry-db'
import { apiRoutes } from '../src/index.js'
import type { ApiRoutesOptions } from '../src/index.js'

function buildApp(opts: Partial<Omit<ApiRoutesOptions, 'db'>> = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-routes-snapshot-'))
  const db = createClient(path.join(tmpDir, 'test.db'))
  migrate(db)

  const app = Fastify()
  app.register(apiRoutes, { db, skipAuth: true, ...opts })
  return { app, tmpDir }
}

const SNAPSHOT_FIXTURE = {
  companyName: 'Acme Corp',
  domain: 'acme.example.com',
  homepageUrl: 'https://acme.example.com',
  generatedAt: '2026-03-29T12:00:00.000Z',
  phrases: ['best enterprise widget provider'],
  competitors: ['widgetco.com'],
  profile: {
    industry: 'Manufacturing',
    summary: 'Acme Corp sells enterprise widget manufacturing services.',
    services: ['Widget manufacturing'],
    categoryTerms: ['enterprise widgets'],
  },
  audit: {
    url: 'https://acme.example.com',
    finalUrl: 'https://acme.example.com',
    auditedAt: '2026-03-29T12:00:00.000Z',
    overallScore: 58,
    overallGrade: 'D+',
    summary: 'Overall grade D+ with weak schema completeness.',
    factors: [],
  },
  queryResults: [
    {
      phrase: 'best enterprise widget provider',
      providerResults: [
        {
          provider: 'openai',
          displayName: 'OpenAI',
          model: 'gpt-5.4',
          mentioned: false,
          cited: false,
          describedAccurately: 'not-mentioned',
          accuracyNotes: null,
          incorrectClaims: [],
          recommendedCompetitors: ['widgetco.com'],
          citedDomains: ['widgetco.com'],
          groundingSources: [],
          searchQueries: ['best enterprise widget provider'],
          answerText: 'WidgetCo is a strong option.',
          error: null,
        },
      ],
    },
  ],
  summary: {
    totalQueries: 1,
    totalProviders: 1,
    totalComparisons: 1,
    mentionCount: 0,
    citationCount: 0,
    topCompetitors: [{ name: 'widgetco.com', count: 1 }],
    visibilityGap: 'Acme Corp was not mentioned in any provider responses.',
    whatThisMeans: ['Competitors are winning category queries.'],
    recommendedActions: ['Improve schema completeness.'],
  },
}

describe('snapshot routes', () => {
  let app: ReturnType<typeof Fastify>
  let tmpDir: string

  beforeAll(async () => {
    const ctx = buildApp({
      onSnapshotRequested: async () => SNAPSHOT_FIXTURE,
    })
    app = ctx.app
    tmpDir = ctx.tmpDir
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('POST /api/v1/snapshot returns a structured report', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/snapshot',
      payload: {
        companyName: 'Acme Corp',
        domain: 'acme.example.com',
      },
    })

    expect(res.statusCode).toBe(200)
    const body = res.json() as typeof SNAPSHOT_FIXTURE
    expect(body.companyName).toBe('Acme Corp')
    expect(body.audit.overallScore).toBe(58)
    expect(body.queryResults[0]?.providerResults[0]?.recommendedCompetitors).toEqual(['widgetco.com'])
  })

  it('POST /api/v1/snapshot validates the payload', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/snapshot',
      payload: {
        companyName: '',
        domain: '',
      },
    })

    expect(res.statusCode).toBe(400)
    const body = res.json() as {
      error: {
        code: string
        details: { issues: Array<{ path: string }> }
      }
    }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.issues.map(issue => issue.path)).toEqual(['companyName', 'domain'])
  })

  it('POST /api/v1/snapshot returns 501 when the server has no snapshot implementation', async () => {
    const ctx = buildApp()
    await ctx.app.ready()

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/snapshot',
      payload: {
        companyName: 'Acme Corp',
        domain: 'acme.example.com',
      },
    })

    expect(res.statusCode).toBe(501)

    await ctx.app.close()
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true })
  })
})
