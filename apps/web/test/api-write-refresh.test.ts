import { QueryObserver, type QueryKey } from '@tanstack/react-query'
import { afterEach, expect, onTestFinished, test } from 'vitest'
import { waitFor } from '@testing-library/react'
import {
  getApiV1ProjectsByNameOptions,
  getApiV1ProjectsByNameQueryTrackingOptions,
  getApiV1ProjectsByNameGoogleGscPerformanceOptions,
  getApiV1ProjectsByNameBingStatusOptions,
  getApiV1ProjectsByNameGaStatusOptions,
  getApiV1ProjectsByNameTechnicalAeoRunsOptions,
  getApiV1ProjectsOptions,
  getApiV1RunsOptions,
  getApiV1ProjectsQueryKey,
  getApiV1SettingsOptions,
} from '@ainyc/canonry-api-client/react-query'
import { postApiV1ProjectsByNameAdsSync, postApiV1ProjectsByNameGbpSync, postApiV1ProjectsByNameGoogleAdsSync, postApiV1ProjectsByNameGtmSync, postApiV1ProjectsByNameQueryTrackingCommit, postApiV1ProjectsByNameQueryTrackingPreview, putApiV1ProjectsByName } from '@ainyc/canonry-api-client'
import { appendQueries, applyProjectConfig, deleteProject, fetchSettings, heyClient, inspectBingSitemap, recordOnboardingEvent, removeLocation, triggerAllRuns, triggerGscSync, triggerInspectSitemap, triggerRun, triggerSiteAudit, updateGoogleAuthConfig } from '../src/api.js'
import { createQueryClient } from '../src/queries/query-client.js'
import { jsonResponse, mockFetch as installMockFetch, pathOf } from './mock-fetch.js'

const clients: Array<ReturnType<typeof createQueryClient>> = []
afterEach(() => clients.splice(0).forEach(client => client.clear()))

function mockFetch(handler: Parameters<typeof installMockFetch>[0]) {
  const restore = installMockFetch(handler)
  const fetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetch(input, init)
    // Native fetch consumes write bodies before response interceptors run.
    if (input instanceof Request && input.body && !input.bodyUsed) await input.text()
    return response
  }) as typeof globalThis.fetch
  return restore
}

function client() {
  const value = createQueryClient()
  value.setDefaultOptions({ queries: { retry: false, staleTime: Infinity } })
  clients.push(value)
  return value
}

async function observe<T>(queryClient: ReturnType<typeof createQueryClient>, queryKey: QueryKey, queryFn: () => Promise<T>) {
  const observer = new QueryObserver(queryClient, { queryKey, queryFn, staleTime: Infinity })
  const unsubscribe = observer.subscribe(() => {})
  onTestFinished(unsubscribe)
  await waitFor(() => expect(observer.getCurrentResult().isSuccess).toBe(true))
  return observer
}

test.each(['simple', 'advanced'])('%s project writes refresh generated and composite views without touching another project', async mode => {
  let revision = 1
  let otherReads = 0
  const name = 'alpha / east'
  const path = `/api/v1/projects/${encodeURIComponent(name)}`
  const restore = mockFetch((url, init) => {
    const requestPath = pathOf(url)
    if (init?.method === 'POST' && [ `${path}/queries`, `${path}/query-tracking/commit` ].includes(requestPath)) {
      revision = 2
      return jsonResponse([])
    }
    if (requestPath === path) return jsonResponse({ id: 'alpha-id', name, configRevision: revision, measurement: mode === 'advanced' ? { revision } : null })
    if (requestPath === `${path}/query-tracking`) return jsonResponse({ revision })
    if (requestPath === '/api/v1/projects/beta') {
      otherReads += 1
      return jsonResponse({ id: 'beta-id', name: 'beta', configRevision: 9 })
    }
    return jsonResponse({ error: { message: `Unexpected ${requestPath}` } }, 404)
  })
  onTestFinished(restore)
  const queryClient = client()
  const projectOptions = getApiV1ProjectsByNameOptions({ client: heyClient, path: { name } })
  const project = new QueryObserver(queryClient, { ...projectOptions, staleTime: Infinity })
  onTestFinished(project.subscribe(() => {}))
  const trackingOptions = getApiV1ProjectsByNameQueryTrackingOptions({ client: heyClient, path: { name } })
  const tracking = new QueryObserver(queryClient, { ...trackingOptions, staleTime: Infinity })
  onTestFinished(tracking.subscribe(() => {}))
  const composite = await observe(queryClient, ['project-dashboard-full', 'alpha-id', 'none', 'overview'], async () => ({ revision }))
  const otherOptions = getApiV1ProjectsByNameOptions({ client: heyClient, path: { name: 'beta' } })
  const other = new QueryObserver(queryClient, { ...otherOptions, staleTime: Infinity })
  onTestFinished(other.subscribe(() => {}))
  await waitFor(() => expect(project.getCurrentResult().data?.configRevision).toBe(1))
  await waitFor(() => expect(other.getCurrentResult().data?.configRevision).toBe(9))

  if (mode === 'advanced') {
    await postApiV1ProjectsByNameQueryTrackingCommit({ client: heyClient, path: { name }, body: { previewToken: 'reviewed-change' } as never })
  } else {
    await appendQueries(name, ['new query'])
  }

  await waitFor(() => expect(project.getCurrentResult().data?.configRevision).toBe(2))
  expect(tracking.getCurrentResult().data).toEqual({ revision: 2 })
  expect(composite.getCurrentResult().data).toEqual({ revision: 2 })
  expect(otherReads).toBe(1)
})

test('settings saves refresh both settings consumers', async () => {
  let configured = false
  const restore = mockFetch((url, init) => {
    if (init?.method === 'PUT') {
      configured = true
      return jsonResponse({ configured })
    }
    if (pathOf(url) === '/api/v1/settings') return jsonResponse({ google: { configured } })
    return jsonResponse({})
  })
  onTestFinished(restore)
  const queryClient = client()
  const generated = new QueryObserver(queryClient, getApiV1SettingsOptions({ client: heyClient }))
  onTestFinished(generated.subscribe(() => {}))
  const legacy = await observe(queryClient, ['settings'], fetchSettings)
  await waitFor(() => expect(generated.getCurrentResult().data?.google.configured).toBe(false))

  await updateGoogleAuthConfig({ clientId: 'test-client', clientSecret: 'test-secret' })

  await waitFor(() => expect(generated.getCurrentResult().data?.google.configured).toBe(true))
  expect(legacy.getCurrentResult().data?.google.configured).toBe(true)
})

test('YAML apply refreshes cached project views even when they are not mounted', async () => {
  let revision = 1
  const restore = mockFetch((url, init) => {
    if (pathOf(url) === '/api/v1/apply' && init?.method === 'POST') {
      revision = 2
      return jsonResponse({})
    }
    return jsonResponse({ id: 'alpha-id', name: 'alpha', configRevision: revision })
  })
  onTestFinished(restore)
  const queryClient = client()
  const options = getApiV1ProjectsByNameOptions({ client: heyClient, path: { name: 'alpha' } })
  await queryClient.fetchQuery(options)

  await applyProjectConfig({ projects: [] })

  const observer = new QueryObserver(queryClient, options)
  onTestFinished(observer.subscribe(() => {}))
  await waitFor(() => expect(observer.getCurrentResult().data?.configRevision).toBe(2))
})

test('failed writes, previews and telemetry leave fresh project reads alone', async () => {
  let reads = 0
  const restore = mockFetch((_url, init) => {
    if (init?.method === 'POST') return jsonResponse({ error: { message: 'Refused' } }, 403)
    reads += 1
    return jsonResponse({ id: 'alpha-id', name: 'alpha', configRevision: 1 })
  })
  onTestFinished(restore)
  const queryClient = client()
  const options = getApiV1ProjectsByNameOptions({ client: heyClient, path: { name: 'alpha' } })
  const observer = new QueryObserver(queryClient, options)
  onTestFinished(observer.subscribe(() => {}))
  await waitFor(() => expect(observer.getCurrentResult().data?.configRevision).toBe(1))
  await expect(appendQueries('alpha', ['new'])).rejects.toThrow('Refused')
  restore()
  const restorePreview = mockFetch((_url, init) => {
    if (init?.method === 'POST') return jsonResponse({})
    reads += 1
    return jsonResponse({ id: 'alpha-id', name: 'alpha', configRevision: 2 })
  })
  onTestFinished(restorePreview)
  await postApiV1ProjectsByNameQueryTrackingPreview({ client: heyClient, path: { name: 'alpha' }, body: {} as never })
  await recordOnboardingEvent({} as never)
  expect(reads).toBe(1)
  expect(observer.getCurrentResult().data?.configRevision).toBe(1)
})

test('a successful write supersedes an unfinished initial read', async () => {
  let reads = 0
  let releaseOldRead!: (response: Response) => void
  const restore = mockFetch((_url, init) => {
    if (init?.method === 'POST') return jsonResponse([])
    reads += 1
    if (reads === 1) return new Promise<Response>(resolve => { releaseOldRead = resolve })
    return jsonResponse({ id: 'alpha-id', name: 'alpha', configRevision: 2 })
  })
  onTestFinished(restore)
  const queryClient = client()
  const observer = new QueryObserver(queryClient, getApiV1ProjectsByNameOptions({ client: heyClient, path: { name: 'alpha' } }))
  onTestFinished(observer.subscribe(() => {}))
  await waitFor(() => expect(reads).toBe(1))

  await appendQueries('alpha', ['new'])

  await waitFor(() => expect(observer.getCurrentResult().data?.configRevision).toBe(2))
  releaseOldRead(jsonResponse({ id: 'alpha-id', name: 'alpha', configRevision: 1 }))
  await waitFor(() => expect(observer.getCurrentResult().fetchStatus).toBe('idle'))
  expect(observer.getCurrentResult().data?.configRevision).toBe(2)
})

test('a previous account deletion cannot evict the replacement account project cache', async () => {
  let releaseDelete!: (response: Response) => void
  let deleteStarted = false
  const restore = mockFetch(() => {
    deleteStarted = true
    return new Promise<Response>(resolve => { releaseDelete = resolve })
  })
  onTestFinished(restore)
  client()
  const deletion = deleteProject('alpha')
  await waitFor(() => expect(deleteStarted).toBe(true))
  const replacement = client()
  const key = getApiV1ProjectsQueryKey({ client: heyClient })
  replacement.setQueryData(key, [{ id: 'different-account-project', name: 'alpha' }])

  releaseDelete(new Response(null, { status: 204 }))
  await deletion

  expect(replacement.getQueryData(key)).toEqual([{ id: 'different-account-project', name: 'alpha' }])
})

test.each(['none', 'sentiment', 'test', 'generate', 'audit-preview'])('deleting project %s preserves unrelated composite caches with matching key metadata', async name => {
  const survivor = { id: 'beta-id', name: 'beta' }
  const restore = mockFetch((_url, init) => init?.method === 'DELETE'
    ? new Response(null, { status: 204 }) : jsonResponse([survivor]))
  onTestFinished(restore)
  const queryClient = client()
  queryClient.setQueryData(getApiV1ProjectsQueryKey({ client: heyClient }), [{ id: 'deleted-id', name }, survivor])
  const dashboardKey = ['project-dashboard-full', survivor.id, 'none', 'overview']
  const sentimentKey = ['sentiment', survivor.name, 'summary']
  queryClient.setQueryData(dashboardKey, { project: survivor })
  queryClient.setQueryData(sentimentKey, { score: 80 })

  await deleteProject(name)

  expect(queryClient.getQueryData(getApiV1ProjectsQueryKey({ client: heyClient }))).toEqual([survivor])
  expect(queryClient.getQueryData(dashboardKey)).toEqual({ project: survivor })
  expect(queryClient.getQueryData(sentimentKey)).toEqual({ score: 80 })
})

test.each(['test', 'generate', 'audit-preview'])('editing project %s refreshes its saved data', async name => {
  let revision = 1
  const restore = mockFetch((_url, init) => {
    if (init?.method === 'PUT') revision = 2
    return jsonResponse({ id: 'alpha-id', name, configRevision: revision })
  })
  onTestFinished(restore)
  const queryClient = client()
  const observer = new QueryObserver(queryClient, getApiV1ProjectsByNameOptions({ client: heyClient, path: { name } }))
  onTestFinished(observer.subscribe(() => {}))
  await waitFor(() => expect(observer.getCurrentResult().data?.configRevision).toBe(1))

  await putApiV1ProjectsByName({ client: heyClient, path: { name }, body: { canonicalDomain: 'example.com', country: 'US', language: 'en' } })

  await waitFor(() => expect(observer.getCurrentResult().data?.configRevision).toBe(2))
})

test('deleting a location named test refreshes the project', async () => {
  let revision = 1
  const restore = mockFetch((_url, init) => {
    if (init?.method === 'DELETE') { revision = 2; return new Response(null, { status: 204 }) }
    return jsonResponse({ id: 'alpha-id', name: 'alpha', configRevision: revision })
  })
  onTestFinished(restore)
  const queryClient = client()
  const observer = new QueryObserver(queryClient, getApiV1ProjectsByNameOptions({ client: heyClient, path: { name: 'alpha' } }))
  onTestFinished(observer.subscribe(() => {}))
  await waitFor(() => expect(observer.getCurrentResult().data?.configRevision).toBe(1))
  await removeLocation('alpha', 'test')
  await waitFor(() => expect(observer.getCurrentResult().data?.configRevision).toBe(2))
})

test.each(['edit', 'delete'])('%s resolves and applies local changes while the replacement read is still pending', async action => {
  let reads = 0
  let releaseRead!: (response: Response) => void
  const projects = [{ id: 'alpha-id', name: 'alpha' }, { id: 'beta-id', name: 'beta' }]
  const restore = mockFetch((_url, init) => {
    if (init?.method === 'DELETE') return new Response(null, { status: 204 })
    if (init?.method === 'POST') return jsonResponse([])
    reads += 1
    return reads === 1 ? jsonResponse(action === 'delete' ? projects : { ...projects[0], configRevision: 1 })
      : new Promise<Response>(resolve => { releaseRead = resolve })
  })
  onTestFinished(restore)
  const queryClient = client()
  if (action === 'delete') {
    const observer = new QueryObserver(queryClient, getApiV1ProjectsOptions({ client: heyClient }))
    onTestFinished(observer.subscribe(() => {}))
  } else {
    const observer = new QueryObserver(queryClient, getApiV1ProjectsByNameOptions({ client: heyClient, path: { name: 'alpha' } }))
    onTestFinished(observer.subscribe(() => {}))
  }
  await waitFor(() => expect(reads).toBe(1))
  let completed = false
  const write = (action === 'delete' ? deleteProject('alpha') : appendQueries('alpha', ['new'])).then(() => { completed = true })
  await waitFor(() => expect(reads).toBe(2))
  try {
    await waitFor(() => expect(completed).toBe(true))
    if (action === 'delete') expect(queryClient.getQueryData(getApiV1ProjectsQueryKey({ client: heyClient }))).toEqual([projects[1]])
  } finally {
    releaseRead(jsonResponse(action === 'delete' ? [projects[1]] : { ...projects[0], configRevision: 2 }))
    await write
  }
})

test.each([
  { scope: 'project', launch: () => triggerRun('alpha') },
  { scope: 'all', launch: () => triggerAllRuns() },
  { scope: 'site-audit', launch: () => triggerSiteAudit('alpha') },
  { scope: 'gsc-sync', launch: () => triggerGscSync('alpha') },
  { scope: 'gsc-inspect-sitemap', launch: () => triggerInspectSitemap('alpha') },
  { scope: 'bing-inspect-sitemap', launch: () => inspectBingSitemap('alpha') },
  { scope: 'gbp-sync', launch: () => postApiV1ProjectsByNameGbpSync({ client: heyClient, path: { name: 'alpha' }, body: {} }) },
  { scope: 'ads-sync', launch: () => postApiV1ProjectsByNameAdsSync({ client: heyClient, path: { name: 'alpha' } }) },
  { scope: 'google-ads-sync', launch: () => postApiV1ProjectsByNameGoogleAdsSync({ client: heyClient, path: { name: 'alpha' } }) },
  { scope: 'gtm-sync', launch: () => postApiV1ProjectsByNameGtmSync({ client: heyClient, path: { name: 'alpha' } }) },
])('$scope job launch refreshes run state without rereading stored evidence, analytics, or Google data', async ({ scope, launch }) => {
  let runReads = 0
  let analyticsReads = 0
  let googleReads = 0
  let evidenceReads = 0
  let scanReads = 0
  let queued = false
  let releaseRuns!: (response: Response) => void
  let releaseEvidence: (() => void) | undefined
  const restore = mockFetch((url, init) => {
    if (init?.method === 'POST') {
      queued = true
      return jsonResponse(scope === 'all' ? [] : scope === 'site-audit' ? { runId: 'queued-run', status: 'queued' } : { id: 'queued-run' })
    }
    if (pathOf(url) === '/api/v1/projects/alpha') return jsonResponse({ id: 'alpha-id', name: 'alpha' })
    if (pathOf(url) === '/api/v1/projects/alpha/technical-aeo/runs') {
      scanReads += 1
      return jsonResponse({ scans: queued && scope === 'site-audit' ? [{ runId: 'queued-run', status: 'queued' }] : [] })
    }
    if (pathOf(url) === '/api/v1/runs') {
      runReads += 1
      return runReads === 1 ? jsonResponse([]) : new Promise<Response>(resolve => { releaseRuns = resolve })
    }
    googleReads += 1
    return jsonResponse({})
  })
  onTestFinished(restore)
  const queryClient = client()
  const runs = new QueryObserver(queryClient, getApiV1RunsOptions({ client: heyClient }))
  onTestFinished(runs.subscribe(() => {}))
  const project = new QueryObserver(queryClient, getApiV1ProjectsByNameOptions({ client: heyClient, path: { name: 'alpha' } }))
  onTestFinished(project.subscribe(() => {}))
  await waitFor(() => expect(project.getCurrentResult().data?.id).toBe('alpha-id'))
  const scans = new QueryObserver(queryClient, getApiV1ProjectsByNameTechnicalAeoRunsOptions({ client: heyClient, path: { name: 'alpha' } }))
  onTestFinished(scans.subscribe(() => {}))
  await waitFor(() => expect(scans.getCurrentResult().isSuccess).toBe(true))
  await observe(queryClient, ['project-dashboard-full', 'alpha-id', 'none', 'evidence'], async () => {
    evidenceReads += 1
    if (evidenceReads > 1) await new Promise<void>(resolve => { releaseEvidence = resolve })
    return { project: { id: 'alpha-id', name: 'alpha' }, queries: [], timeline: [], latestRunDetails: [] }
  })
  await observe(queryClient, ['analytics-metrics', 'alpha', '90d'], async () => { analyticsReads += 1; return { trend: [] } })
  const google = new QueryObserver(queryClient, getApiV1ProjectsByNameGoogleGscPerformanceOptions({ client: heyClient, path: { name: 'alpha' } }))
  onTestFinished(google.subscribe(() => {}))
  await waitFor(() => expect(google.getCurrentResult().isSuccess).toBe(true))
  let completed = false
  const write = launch().then(() => { completed = true })
  await waitFor(() => expect(runReads).toBe(2))
  try {
    expect(evidenceReads).toBe(1)
    expect(analyticsReads).toBe(1)
    expect(googleReads).toBe(1)
    if (scope === 'site-audit') {
      await waitFor(() => expect(scans.getCurrentResult().data?.scans).toEqual([{ runId: 'queued-run', status: 'queued' }]))
      expect(scanReads).toBe(2)
    }
    await waitFor(() => expect(completed).toBe(true))
  } finally {
    releaseEvidence?.()
    releaseRuns(jsonResponse([]))
    await write
  }
})

test.each([
  { name: 'Google Search Console', load: (queryClient: ReturnType<typeof createQueryClient>) => queryClient.fetchQuery(getApiV1ProjectsByNameGoogleGscPerformanceOptions({ client: heyClient, path: { name: 'alpha' } })) },
  { name: 'Bing', load: (queryClient: ReturnType<typeof createQueryClient>) => queryClient.fetchQuery(getApiV1ProjectsByNameBingStatusOptions({ client: heyClient, path: { name: 'alpha' } })) },
  { name: 'Google Analytics', load: (queryClient: ReturnType<typeof createQueryClient>) => queryClient.fetchQuery(getApiV1ProjectsByNameGaStatusOptions({ client: heyClient, path: { name: 'alpha' } })) },
])('$name imperative initial load is not cancelled by another successful write', async ({ load }) => {
  let releaseRead!: (response: Response) => void
  let started = false
  const restore = mockFetch((_url, init) => {
    if (init?.method === 'POST') return jsonResponse([])
    started = true
    return new Promise<Response>(resolve => { releaseRead = resolve })
  })
  onTestFinished(restore)
  const queryClient = client()
  const initial = load(queryClient)
    .then(data => ({ data }), error => ({ error }))
  await waitFor(() => expect(started).toBe(true))
  await appendQueries('alpha', ['new'])
  releaseRead(jsonResponse({ connected: true }))
  expect(await initial).toEqual({ data: { connected: true } })
})
