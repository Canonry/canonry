import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { listDemoReadRoutes } from '../src/demo/access.js'
import { createDemoServer } from '../src/demo-server.js'

// Every allowlisted GET runs against the seeded, query-only database. A read
// that starts writing (or calling a provider) fails only in the demo, so each
// one is exercised here for both sample projects.

const PROJECTS = { 'summit-roofing': 'summit-roofing.example', 'harbor-resorts': 'harbor-resorts.example' } as const
type ProjectName = keyof typeof PROJECTS
type Json = any // eslint-disable-line @typescript-eslint/no-explicit-any
type Lookup = { project: ProjectName; read: (path: string) => Promise<Json>; record: (kind: RecordKind) => Promise<string> }

/** One seeded record of each kind a route addresses, or undefined when the sample has none. */
const SAMPLE_RECORDS = {
  adsOperation: async ({ read }: Lookup) => (await read('ads/operations')).operations[0]?.operationKey,
  contentTarget: async ({ read }: Lookup) => (await read('content/targets')).targets[0]?.targetRef,
  conversionContract: async ({ read }: Lookup) => (await read('conversion-tracking/contracts'))[0]?.id,
  discoverySession: async ({ read }: Lookup) => (await read('discover/sessions'))[0]?.id,
  insight: async ({ read }: Lookup) => (await read('insights'))[0]?.id,
  trafficSource: async ({ read }: Lookup) => (await read('traffic/sources')).sources[0]?.id,
  firstAnswerRun: async ({ read }: Lookup) => (await read('runs'))[0]?.id,
  lastAnswerRun: async ({ read }: Lookup) => (await read('runs')).at(-1)?.id,
  googleAdsSnapshot: async ({ read }: Lookup) => (await read('google-ads/snapshots')).snapshots[0]?.id,
  gtmSnapshot: async ({ read }: Lookup) => (await read('gtm/snapshots')).snapshots[0]?.id,
  planRevision: async ({ read }: Lookup) => (await read('measurement-plan/versions')).versions[0]?.revision?.toString(),
  querySet: async ({ read }: Lookup) => (await read('measurement-query-sets')).querySets[0]?.id,
  researchRun: async ({ read }: Lookup) => (await read('research/runs')).runs[0]?.id,
  siteAuditRun: async ({ read }: Lookup) => (await read('technical-aeo/runs')).scans[0]?.runId,
  measurementProperty: async ({ read }: Lookup) => (await read('measurement-plan/draft/targets'))?.items?.[0]?.stableKey,
  measurementResult: async ({ read, record }: Lookup) => {
    const targetKey = await record('measurementProperty')
    return (await read(`measurement-property-questions?targetKey=${encodeURIComponent(targetKey)}`))?.questions?.find((row: Json) => row.resultId)?.resultId
  },
} satisfies Record<string, (lookup: Lookup) => Promise<string | undefined>>
type RecordKind = keyof typeof SAMPLE_RECORDS

/** The sample deliberately has none of these; their routes are still requested with a missing id. */
const UNSEEDED_RECORDS = [
  'harbor-resorts adsOperation',
  'harbor-resorts querySet',
  'summit-roofing adsOperation',
  'summit-roofing measurementProperty',
  'summit-roofing measurementResult',
  'summit-roofing planRevision',
  'summit-roofing querySet',
]
const MISSING_RECORD = 'missing-sample-record'

/**
 * Keyed by the route prefix ending in the parameter, because one name (:id,
 * :runId, :snapshotId) addresses different records under different routes.
 */
const PATH_PARAMETERS: Record<string, RecordKind | 'project'> = {
  '/api/v1/projects/:name': 'project',
  '/api/v1/projects/:name/ads/operations/:operationKey': 'adsOperation',
  '/api/v1/projects/:name/content/recommendations/:targetRef': 'contentTarget',
  '/api/v1/projects/:name/conversion-tracking/contracts/:contractId': 'conversionContract',
  '/api/v1/projects/:name/discover/sessions/:id': 'discoverySession',
  '/api/v1/projects/:name/google-ads/snapshots/:snapshotId': 'googleAdsSnapshot',
  '/api/v1/projects/:name/gtm/snapshots/:snapshotId': 'gtmSnapshot',
  '/api/v1/projects/:name/insights/:id': 'insight',
  '/api/v1/projects/:name/measurement-plan/versions/:revision': 'planRevision',
  '/api/v1/projects/:name/measurement-query-sets/:setId': 'querySet',
  '/api/v1/projects/:name/research/runs/:runId': 'researchRun',
  '/api/v1/projects/:name/technical-aeo/runs/:runId': 'siteAuditRun',
  '/api/v1/projects/:name/traffic/sources/:id': 'trafficSource',
  '/api/v1/runs/:id': 'firstAnswerRun',
}

/** Routes whose handlers refuse to run without these query parameters. */
const REQUIRED_QUERIES: Record<string, (lookup: Lookup) => Promise<Record<string, string>>> = {
  '/api/v1/projects/:name/measurement-overview': async () => ({ scope: 'all' }),
  '/api/v1/projects/:name/measurement-property-competitors': async ({ record }) => ({ targetKey: await record('measurementProperty') }),
  '/api/v1/projects/:name/measurement-property-evidence': async ({ record }) => ({ targetKey: await record('measurementProperty') }),
  '/api/v1/projects/:name/measurement-property-questions': async ({ record }) => ({ targetKey: await record('measurementProperty') }),
  '/api/v1/projects/:name/measurement-question-result': async ({ record }) => ({ targetKey: await record('measurementProperty'), resultId: await record('measurementResult') }),
  '/api/v1/projects/:name/measurement-report': async ({ record }) => {
    const revision = await record('planRevision')
    return { revision: revision === MISSING_RECORD ? '1' : revision }
  },
  '/api/v1/projects/:name/search': async () => ({ q: 'resort roof' }),
  '/api/v1/projects/:name/snapshots/diff': async ({ record }) => ({ run1: await record('firstAnswerRun'), run2: await record('lastAnswerRun') }),
  '/api/v1/projects/:name/technical-aeo/crawl/pages/audit': async ({ project }) => ({ url: `https://${PROJECTS[project]}/` }),
  '/api/v1/projects/:name/technical-aeo/internal-links/neighbors': async ({ project }) => ({ url: `https://${PROJECTS[project]}/` }),
  '/api/v1/projects/:name/technical-aeo/path': async ({ project }) => ({ toUrl: `https://${PROJECTS[project]}/contact/` }),
  '/api/v1/projects/:name/visibility-compare': async () => {
    const now = new Date()
    const month = (date: Date) => date.toISOString().slice(0, 7)
    return { from: month(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))), to: month(now) }
  },
}

function parameterPrefixes(route: string): string[] {
  return [...route.matchAll(/:[a-z]+/gi)].map(match => route.slice(0, match.index + match[0].length))
}

const dir = mkdtempSync(join(tmpdir(), 'canonry-demo-route-coverage-'))
let app: Awaited<ReturnType<typeof createDemoServer>>
const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Demo must not use the network'))
let visitor = 0
// A distinct forwarded address per request keeps this sweep clear of the per-visitor API budget.
const inject = (url: string) => {
  visitor += 1
  return app.inject({ url, headers: { 'x-forwarded-for': `10.${(visitor >> 16) & 255}.${(visitor >> 8) & 255}.${visitor & 255}` } })
}

beforeAll(async () => {
  mkdirSync(join(dir, 'assets'))
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head></head><body><div id="root"></div></body></html>')
  app = await createDemoServer({ assetsDir: dir })
}, 60_000)
afterAll(async () => { await app?.close(); network.mockRestore(); rmSync(dir, { recursive: true, force: true }) })

describe('seeded demo route coverage', () => {
  it('maps every path parameter and required query of the allowlist, and nothing else', () => {
    const routes = listDemoReadRoutes()
    const prefixes = new Set(routes.flatMap(parameterPrefixes))
    const unmapped = [...prefixes].filter(prefix => !(prefix in PATH_PARAMETERS))
    expect(unmapped, 'Allowlisted routes have path parameters with no seeded value in PATH_PARAMETERS').toEqual([])
    expect(Object.keys(PATH_PARAMETERS).filter(prefix => !prefixes.has(prefix)), 'Stale PATH_PARAMETERS entries').toEqual([])
    expect(Object.keys(REQUIRED_QUERIES).filter(route => !routes.includes(route)), 'Stale REQUIRED_QUERIES entries').toEqual([])
  })

  it('answers every allowlisted GET for both sample projects without a server error', async () => {
    const unseeded = new Set<string>()
    const failures: string[] = []
    for (const project of Object.keys(PROJECTS) as ProjectName[]) {
      const found = new Map<RecordKind, string>()
      const lookup: Lookup = {
        project,
        read: async path => {
          const response = await inject(`/api/v1/projects/${project}/${path}`)
          return response.statusCode === 200 ? response.json() : undefined
        },
        record: async kind => {
          if (!found.has(kind)) {
            const value = await SAMPLE_RECORDS[kind](lookup)
            if (value === undefined) unseeded.add(`${project} ${kind}`)
            found.set(kind, value ?? MISSING_RECORD)
          }
          return found.get(kind)!
        },
      }
      for (const route of listDemoReadRoutes()) {
        let url = route
        for (const prefix of parameterPrefixes(route)) {
          const kind = PATH_PARAMETERS[prefix]
          if (kind === undefined) throw new Error(`No seeded value is mapped for ${prefix} (route ${route}). Add it to PATH_PARAMETERS.`)
          const value = kind === 'project' ? project : await lookup.record(kind)
          url = url.replace(/:[a-z]+/i, encodeURIComponent(value))
        }
        const query = await REQUIRED_QUERIES[route]?.(lookup)
        if (query) url += `?${new URLSearchParams(query)}`
        const response = await inject(url)
        // 403 means the route is allowlisted but no longer registered; 400 means the handler never ran.
        if (response.statusCode >= 500 || response.statusCode === 403 || response.statusCode === 400) {
          failures.push(`${response.statusCode} GET ${url}: ${response.body.slice(0, 200)}`)
        }
      }
    }
    expect(failures).toEqual([])
    expect([...unseeded].sort(), 'The sample gained or lost a record kind; update UNSEEDED_RECORDS').toEqual(UNSEEDED_RECORDS)
    expect(network).not.toHaveBeenCalled()
  }, 120_000)
})
