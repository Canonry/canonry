import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { SeoRunStatuses, type SeoContext, type SeoOverview, type SeoProfile, type SeoProfileInput, type SeoProvenance, type SeoRankedKeyword, type SeoRun } from '@canonry/canonry-contracts'
import { SeoDataSection } from '../src/components/project/SeoDataSection.js'
import { createQueryClient } from '../src/queries/query-client.js'

// These tests own the browser transport/lifecycle boundary. Provider arithmetic
// and permission enforcement belong to the API tests; no SDK hooks are mocked.
const source: SeoProvenance = {
  provider: 'dataforseo', dataset: 'dataforseo_labs/google/ranked_keywords', engine: 'google',
  locationCode: 2840, languageCode: 'en', device: 'unspecified',
  collectedAt: '2026-10-20T12:00:00Z', sourceUpdatedAt: null,
}
const simple: SeoProfile = {
  id: 'simple', name: 'Project search', connectionId: 'managed', revision: 1,
  capabilities: ['ranked-keywords', 'keyword-metrics', 'domain-intelligence'],
  targets: [{ kind: 'domain', value: 'example.com', includeSubdomains: true }],
  keywords: ['example keyword'], locationCode: 2840, languageCode: 'en', limit: 100,
  scope: { kind: 'project' }, createdAt: source.collectedAt, updatedAt: source.collectedAt,
}
const advanced: SeoProfile = {
  ...simple, id: 'advanced', name: 'French property', locationCode: 2250, languageCode: 'fr',
  scope: { kind: 'property', key: 'property-fr', expectedPlanRevision: 7 },
  targets: [{ kind: 'host', value: 'fr.example.com', includeSubdomains: false }],
  capabilities: ['ranked-keywords'],
}
const context: SeoContext = {
  available: true, reason: null, access: { canRun: true, canWrite: true },
  connections: [{ id: 'managed', label: 'Managed SEO source', provider: 'dataforseo', capabilities: ['ranked-keywords', 'keyword-metrics', 'domain-intelligence'] }],
  scopes: [
    { kind: 'project', key: null, label: 'Entire project', supported: true, reason: null },
    { kind: 'property', key: 'property-fr', label: 'France · fr.example.com', planRevision: 7, supported: true, reason: null },
  ],
}
const saved: SeoRun = {
  id: 'saved-simple', projectId: 'project-id', profileId: 'simple', status: 'completed',
  profileRevision: 1, locationCode: 2840, languageCode: 'en', cancelRequested: false,
  capabilities: simple.capabilities, scope: simple.scope, taskCount: 3, completedTasks: 3, failedTasks: 0,
  createdAt: source.collectedAt, startedAt: source.collectedAt, finishedAt: source.collectedAt, error: null,
}
const ranked: SeoRankedKeyword = {
  target: simple.targets[0], keyword: 'saved keyword', url: 'https://example.com/saved',
  rankOrganic: 4, rankAbsolute: 7, searchVolume: 0, estimatedTraffic: null, cpcUsd: 2.31,
  keywordDifficulty: 43, serpFeatures: ['featured_snippet'], provenance: source,
}
function overview(profile: SeoProfile, latestRun: SeoRun = { ...saved, id: `saved-${profile.id}`, profileId: profile.id }): SeoOverview {
  return {
    profiles: [profile], latestRun, evidenceRunId: `saved-${profile.id}`, evidenceRun: { ...saved, id: `saved-${profile.id}`, profileId: profile.id, capabilities: profile.capabilities, scope: profile.scope, locationCode: profile.locationCode, languageCode: profile.languageCode },
    status: { available: true, reason: null, capabilities: profile.capabilities, profileCount: 2, latestRunId: latestRun.id, latestRunStatus: latestRun.status, lastCompletedAt: source.collectedAt },
    summary: { target: profile.targets[0], organicKeywords: 721, inTop10: 123, estimatedOrganicTraffic: 98.4, provenance: source },
    keywordMetricsCount: 1, domainIntelligenceCount: 1, rankedKeywordCount: 1,
  }
}
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}
const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  clients.splice(0).forEach(client => client.clear())
  vi.unstubAllGlobals()
  delete window.__CANONRY_CONFIG__
})

async function mount(profileId: string | null = 'simple', runId?: string) {
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { retry: false, gcTime: 0, staleTime: Infinity }, mutations: { retry: false } })
  clients.push(client)
  const root = createRootRoute({
    validateSearch: (search: Record<string, unknown>) => ({ seoProfileId: typeof search.seoProfileId === 'string' ? search.seoProfileId : undefined, seoRunId: typeof search.seoRunId === 'string' ? search.seoRunId : undefined }),
  })
  const route = createRoute({ getParentRoute: () => root, path: '/projects/$projectName/seo-data', component: () => <SeoDataSection projectName="example" /> })
  const search = new URLSearchParams()
  if (profileId) search.set('seoProfileId', profileId)
  if (runId) search.set('seoRunId', runId)
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({ initialEntries: [`/projects/example/seo-data?${search}`] }) })
  await router.load()
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return { client, router }
}

test('profile selection pins SDK evidence and renders server values, zero, and missing data without mixing scopes', async () => {
  const reads: URL[] = []
  vi.stubGlobal('fetch', async (request: Request) => {
    const url = new URL(request.url)
    reads.push(url)
    if (url.pathname.endsWith('/context')) return json(context)
    if (url.pathname.endsWith('/profiles')) return json({ profiles: [simple, advanced] })
    const profile = url.searchParams.get('profileId') === 'advanced' ? advanced : simple
    if (url.pathname.endsWith('/overview')) return json(overview(profile))
    if (url.pathname.endsWith('/ranked-keywords')) return json({ runId: `saved-${profile.id}`, total: 1, limit: 25, offset: 0, items: [{ ...ranked, keyword: profile.id === 'advanced' ? 'mot clé français' : 'saved keyword', target: profile.targets[0] }] })
    throw new Error(`Unexpected request ${request.method} ${url.pathname}`)
  })
  const { router } = await mount()
  const table = await screen.findByRole('table', { name: 'Ranked keywords from the selected refresh' })
  expect(within(table).getByText('saved keyword')).not.toBeNull()
  expect(screen.getByText('123')).not.toBeNull()
  expect(screen.getByText('721')).not.toBeNull()
  expect(within(table).getByText('0')).not.toBeNull()
  expect(within(table).getByLabelText('Not supplied')).not.toBeNull()
  const initial = reads.find(url => url.pathname.endsWith('/ranked-keywords'))!
  expect(initial.pathname).toBe('/api/v1/projects/example/seo/ranked-keywords')
  expect(Object.fromEntries(initial.searchParams)).toEqual({ profileId: 'simple', runId: 'saved-simple', limit: '25', offset: '0' })

  fireEvent.change(screen.getByRole('combobox', { name: 'SEO profile' }), { target: { value: 'advanced' } })
  await screen.findByText('mot clé français')
  expect(screen.queryByText('saved keyword')).toBeNull()
  expect(screen.getByText('Location 2250 · fr')).not.toBeNull()
  expect(router.state.location.search.seoProfileId).toBe('advanced')
  const advancedRead = reads.find(url => url.pathname.endsWith('/ranked-keywords') && url.searchParams.get('profileId') === 'advanced')!
  expect(advancedRead.searchParams.get('runId')).toBe('saved-advanced')
})

test.each([SeoRunStatuses.completed, SeoRunStatuses.partial, null])('selected profile freshness uses its %s evidence, never another profile completion', async status => {
  const selectedFinishedAt = '2026-10-18T12:00:00Z'
  const selectedOverview = overview(advanced)
  selectedOverview.status.lastCompletedAt = '2026-10-22T12:00:00Z'
  selectedOverview.evidenceRun = status ? { ...saved, id: 'saved-advanced', profileId: advanced.id, scope: advanced.scope, status, finishedAt: selectedFinishedAt } : null
  selectedOverview.evidenceRunId = selectedOverview.evidenceRun?.id ?? null
  selectedOverview.latestRun = selectedOverview.evidenceRun
  selectedOverview.summary = null
  vi.stubGlobal('fetch', async (request: Request) => {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/context')) return json(context)
    if (url.pathname.endsWith('/profiles')) return json({ profiles: [simple, advanced] })
    if (url.pathname.endsWith('/overview')) return json(selectedOverview)
    if (url.pathname.endsWith('/ranked-keywords')) return json({ runId: 'saved-advanced', total: 0, limit: 25, offset: 0, items: [] })
    throw new Error(`Unexpected request ${url.pathname}`)
  })
  await mount('advanced')
  await screen.findByRole('heading', { name: status ? 'No results returned' : 'No saved data yet' })
  if (status) {
    const freshness = screen.getByText(status === SeoRunStatuses.partial ? /^Partial refresh finished/ : /^Last completed/)
    expect(freshness.textContent).toContain('Oct 18, 2026')
    expect(freshness.querySelector('time')?.getAttribute('datetime')).toBe(selectedFinishedAt)
  } else {
    expect(screen.getByText('No completed refresh')).not.toBeNull()
    expect(screen.queryByText(/^Last completed/)).toBeNull()
  }
})

test.each([false, true])('an unconfigured source gives a setup next step while preserving saved evidence (%s)', async hasSavedProfile => {
  const reason = 'SEO execution is not configured on this host.'
  vi.stubGlobal('fetch', async (request: Request) => {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/context')) return json({ ...context, available: false, reason, connections: [], scopes: [{ ...context.scopes[0], supported: false, capabilities: [], reason }] })
    if (url.pathname.endsWith('/profiles')) return json({ profiles: hasSavedProfile ? [simple] : [] })
    if (hasSavedProfile && url.pathname.endsWith('/overview')) {
      const value = overview(simple)
      return json({ ...value, status: { ...value.status, available: false, reason, capabilities: [] } })
    }
    if (hasSavedProfile && url.pathname.endsWith('/ranked-keywords')) return json({ runId: saved.id, total: 1, limit: 25, offset: 0, items: [ranked] })
    throw new Error(`Unexpected unconfigured-source request ${request.method} ${url.pathname}`)
  })
  await mount(hasSavedProfile ? simple.id : null)
  if (hasSavedProfile) {
    await screen.findByText('saved keyword')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh data' }).disabled).toBe(true)
  } else {
    await screen.findByRole('heading', { name: 'Configure an SEO data provider' })
    expect(screen.getByText('Connect a provider before creating an SEO profile.')).toBeTruthy()
    expect(screen.queryByText(/administrator/i)).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'SEO profile' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Refresh data' })).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  }
  expect(screen.queryByRole('button', { name: 'New profile' })).toBeNull()
})

test('a configured source with an unavailable Advanced scope shows the plan recovery instruction', async () => {
  const reason = 'Publish a current Advanced Measurement plan first.'
  vi.stubGlobal('fetch', async (request: Request) => {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/context')) return json({ ...context, scopes: [{ ...context.scopes[0], supported: false, capabilities: [], reason }] })
    if (url.pathname.endsWith('/profiles')) return json({ profiles: [] })
    throw new Error(`Unexpected unavailable-scope request ${request.method} ${url.pathname}`)
  })
  await mount(null)
  await screen.findByRole('heading', { name: 'SEO scope unavailable' })
  expect(screen.getByText(reason)).not.toBeNull()
  expect(screen.queryByRole('heading', { name: 'Configure an SEO data provider' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'New profile' })).toBeNull()
})

test.each(['Edit profile', 'New profile'])('%s restores its opener after closing or cancelling the editor', async action => {
  vi.stubGlobal('fetch', async (request: Request) => {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/context')) return json(context)
    if (url.pathname.endsWith('/profiles')) return json({ profiles: [simple] })
    if (url.pathname.endsWith('/overview')) return json(overview(simple))
    if (url.pathname.endsWith('/ranked-keywords')) return json({ runId: saved.id, total: 1, limit: 25, offset: 0, items: [ranked] })
    throw new Error(`Unexpected editor request ${request.method} ${url.pathname}`)
  })
  await mount()
  await screen.findByText('saved keyword')
  const opener = screen.getByRole('button', { name: action })
  for (const closeAction of ['Close profile editor', 'Cancel']) {
    opener.focus()
    fireEvent.click(opener)
    const form = await screen.findByRole('form', { name: action === 'Edit profile' ? 'Edit SEO profile' : 'New SEO profile' })
    await waitFor(() => expect(document.activeElement).toBe(within(form).getByRole('textbox', { name: 'Profile name' })))
    const close = within(form).getByRole('button', { name: closeAction })
    close.focus()
    fireEvent.click(close)
    await waitFor(() => expect(document.activeElement).toBe(opener))
    expect(screen.queryByRole('form')).toBeNull()
  }
})

test('profile editing clears unsupported datasets when Advanced scope narrows and saves only the allowed selection', async () => {
  const hostScope = { ...context.scopes[1]!, capabilities: ['keyword-metrics', 'ranked-keywords'] as SeoProfile['capabilities'] }
  const pathScope = { ...hostScope, key: 'property-docs', label: 'Documentation path', capabilities: ['keyword-metrics'] as SeoProfile['capabilities'], reason: 'This scope supports explicit keyword metrics only.' }
  let current = simple
  const writes: unknown[] = []
  vi.stubGlobal('fetch', async (request: Request) => {
    const url = new URL(request.url)
    if (request.method === 'PUT') {
      const input: unknown = await request.json()
      writes.push(input)
      current = { ...simple, ...(input as Partial<SeoProfile>), revision: 2 }
      return json(current)
    }
    if (url.pathname.endsWith('/context')) return json({ ...context, scopes: [context.scopes[0], hostScope, pathScope] })
    if (url.pathname.endsWith('/profiles')) return json({ profiles: [current] })
    if (url.pathname.endsWith('/overview')) return json({ ...overview(current), evidenceRun: saved, summary: overview(simple).summary })
    if (url.pathname.endsWith('/ranked-keywords')) return json({ runId: saved.id, total: 1, limit: 25, offset: 0, items: [ranked] })
    throw new Error(`Unexpected request ${url.pathname}`)
  })
  await mount()
  await screen.findByText('saved keyword')
  fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }))
  const form = screen.getByRole('form', { name: 'Edit SEO profile' })
  const dataset = (label: string) => within(form).getByRole<HTMLInputElement>('checkbox', { name: label })
  fireEvent.change(within(form).getByRole('combobox', { name: 'Measurement scope' }), { target: { value: 'property:property-fr' } })
  expect(dataset('Domain comparison').disabled).toBe(true)
  expect(dataset('Domain comparison').checked).toBe(false)
  expect(dataset('Ranked keywords').checked).toBe(true)
  fireEvent.change(within(form).getByRole('combobox', { name: 'Measurement scope' }), { target: { value: 'property:property-docs' } })
  expect(dataset('Ranked keywords').disabled).toBe(true)
  expect(dataset('Ranked keywords').checked).toBe(false)
  expect(dataset('Keyword metrics').checked).toBe(true)
  expect(within(form).getByText('This scope supports explicit keyword metrics only.')).not.toBeNull()
  fireEvent.click(within(form).getByRole('button', { name: 'Save profile' }))
  await waitFor(() => expect(writes).toHaveLength(1))
  expect(writes[0]).toMatchObject({ capabilities: ['keyword-metrics'], keywords: ['example keyword'], scope: { kind: 'property', key: 'property-docs', expectedPlanRevision: 7 } })
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'SEO profile' })))
  expect(screen.queryByRole('form', { name: 'Edit SEO profile' })).toBeNull()
})

test.each(['project', 'path Property'])('a new keyword-only profile for %s saves without unrelated target fields', async scopeLabel => {
  const pathScope: SeoContext['scopes'][number] = { kind: 'property', key: 'docs', label: 'Documentation path', planRevision: 7, supported: true, capabilities: ['keyword-metrics'], reason: 'Supports explicit keyword metrics only.' }
  let created: SeoProfile | undefined
  const writes: SeoProfileInput[] = []
  vi.stubGlobal('fetch', async (request: Request) => {
    const url = new URL(request.url)
    if (request.method === 'PUT') {
      const input = await request.json() as SeoProfileInput
      writes.push(input)
      created = { ...input, id: url.pathname.split('/').at(-1)!, revision: 1, createdAt: source.collectedAt, updatedAt: source.collectedAt }
      return json(created)
    }
    if (url.pathname.endsWith('/context')) return json({ ...context, scopes: [context.scopes[0], pathScope] })
    if (url.pathname.endsWith('/profiles')) return json({ profiles: created ? [created] : [] })
    if (created && url.pathname.endsWith('/overview')) return json({
      status: { available: true, reason: null, capabilities: ['keyword-metrics'], profileCount: 1, latestRunId: null, latestRunStatus: null, lastCompletedAt: null },
      profiles: [created], latestRun: null, evidenceRun: null, evidenceRunId: null, summary: null,
      keywordMetricsCount: 0, domainIntelligenceCount: 0, rankedKeywordCount: 0,
    } satisfies SeoOverview)
    throw new Error(`Unexpected profile creation request ${request.method} ${url.pathname}`)
  })
  await mount(null)
  fireEvent.click(await screen.findByRole('button', { name: 'New profile' }))
  const form = screen.getByRole('form', { name: 'New SEO profile' })
  fireEvent.change(within(form).getByRole('textbox', { name: 'Profile name' }), { target: { value: 'Keyword research' } })
  if (scopeLabel === 'path Property') {
    fireEvent.change(within(form).getByRole('combobox', { name: 'Measurement scope' }), { target: { value: 'property:docs' } })
  }
  for (const label of ['Ranked keywords', 'Domain comparison']) {
    const checkbox = within(form).getByRole<HTMLInputElement>('checkbox', { name: label })
    if (checkbox.checked) fireEvent.click(checkbox)
  }
  const keywords = within(form).getByRole<HTMLInputElement>('checkbox', { name: 'Keyword metrics' })
  if (!keywords.checked) fireEvent.click(keywords)
  expect(within(form).queryByRole('group', { name: 'Targets' })).toBeNull()
  expect(within(form).queryByRole('spinbutton', { name: 'Ranked rows per target' })).toBeNull()
  fireEvent.change(within(form).getByRole('textbox', { name: /^Keywords/ }), { target: { value: 'solar installer\nhome solar cost' } })
  fireEvent.change(within(form).getByRole('spinbutton', { name: /^Provider location code/ }), { target: { value: '2840' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Save profile' }))
  await waitFor(() => expect(writes).toHaveLength(1))
  expect(writes[0]).toMatchObject({
    name: 'Keyword research', capabilities: ['keyword-metrics'], targets: [], keywords: ['solar installer', 'home solar cost'], locationCode: 2840, languageCode: 'en',
    scope: scopeLabel === 'path Property' ? { kind: 'property', key: 'docs', expectedPlanRevision: 7 } : { kind: 'project' },
  })
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'SEO profile' })))
})

test('an ambiguous refresh retry reuses its intent and identity while saved evidence remains visible', async () => {
  const requests: Array<{ url: URL; body: unknown }> = []
  let syncing = false
  let attempts = 0
  const running: SeoRun = { ...saved, id: 'new-refresh', status: 'running', completedTasks: 0, finishedAt: null }
  vi.stubGlobal('fetch', async (request: Request) => {
    const url = new URL(request.url)
    const body: unknown = request.method === 'POST' ? await request.json() : null
    requests.push({ url, body })
    if (url.pathname.endsWith('/context')) return json(context)
    if (url.pathname.endsWith('/profiles')) return json({ profiles: [simple] })
    if (url.pathname.endsWith('/overview')) return json(overview(simple, syncing ? running : saved))
    if (url.pathname.endsWith('/ranked-keywords')) return json({ runId: 'saved-simple', total: 1, limit: 25, offset: 0, items: [ranked] })
    if (url.pathname.endsWith('/refresh-intents')) return json({ token: 'bounded-intent', expiresAt: '2026-10-23T12:00:00Z', profileId: simple.id, profileRevision: 1, taskCount: 3, targets: simple.targets, capabilities: simple.capabilities, availability: 'ready', reason: null })
    if (url.pathname.endsWith('/sync')) {
      attempts += 1
      if (attempts === 1) throw new TypeError('Connection interrupted')
      syncing = true
      return json(running)
    }
    throw new Error(`Unexpected request ${request.method} ${url.pathname}`)
  })
  await mount()
  await screen.findByText('saved keyword')
  fireEvent.click(screen.getByRole('button', { name: 'Refresh data' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Connection interrupted')
  fireEvent.click(screen.getByRole('button', { name: 'Retry refresh' }))
  await screen.findByRole('button', { name: 'Refresh in progress' })
  expect(screen.getByText('saved keyword')).not.toBeNull()
  expect(screen.getByText('721')).not.toBeNull()
  expect(requests.filter(request => request.url.pathname.endsWith('/refresh-intents'))).toHaveLength(1)
  const syncs = requests.filter(request => request.url.pathname.endsWith('/sync'))
  expect(syncs).toHaveLength(2)
  expect(syncs[0].body).toEqual(syncs[1].body)
  expect(syncs[0].body).toEqual({ quoteToken: 'bounded-intent', idempotencyKey: expect.any(String) })
  expect(requests.filter(request => request.url.pathname.endsWith('/ranked-keywords')).every(request => request.url.searchParams.get('runId') === 'saved-simple')).toBe(true)
})

test('read-only access keeps source evidence available, exposes scope refusal, and cannot create or refresh', async () => {
  const methods: string[] = []
  vi.stubGlobal('fetch', async (request: Request) => {
    methods.push(request.method)
    const url = new URL(request.url)
    if (url.pathname.endsWith('/context')) return json({ ...context, access: { canRun: false, canWrite: false }, scopes: [{ ...context.scopes[1], supported: false, reason: 'Exact host cannot be used for domain comparison.' }] })
    if (url.pathname.endsWith('/profiles')) return json({ profiles: [advanced] })
    if (url.pathname.endsWith('/overview')) return json(overview(advanced))
    if (url.pathname.endsWith('/ranked-keywords')) return json({ runId: 'saved-advanced', total: 1, limit: 25, offset: 0, items: [ranked] })
    throw new Error(`Unexpected request ${request.method} ${url.pathname}`)
  })
  await mount('advanced')
  await screen.findByText('saved keyword')
  expect(screen.getByText('Exact host cannot be used for domain comparison.')).not.toBeNull()
  expect(screen.getByText('Read-only access')).not.toBeNull()
  expect(screen.queryByRole('button', { name: 'Refresh data' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'New profile' })).toBeNull()
  fireEvent.click(screen.getByText('Details', { selector: 'summary' }))
  expect(screen.getByText('$2.31', { exact: false })).not.toBeNull()
  expect(within(screen.getByRole('table')).getByText('DataForSEO · dataforseo_labs/google/ranked_keywords')).not.toBeNull()
  expect(document.body.textContent).not.toMatch(/request cost|budget|billing|receipt|spend/i)
  expect(methods.every(method => method === 'GET')).toBe(true)
})

test('an unavailable saved profile never silently falls back to another scope', async () => {
  const reads: string[] = []
  vi.stubGlobal('fetch', async (request: Request) => {
    const url = new URL(request.url)
    reads.push(url.pathname)
    if (url.pathname.endsWith('/context')) return json(context)
    if (url.pathname.endsWith('/profiles')) return json({ profiles: [simple] })
    throw new Error(`Unexpected scope read ${url.pathname}`)
  })
  const { client } = await mount('deleted-profile')
  await screen.findByRole('heading', { name: 'Profile unavailable' })
  await waitFor(() => expect(client.isFetching()).toBe(0))
  expect(reads.some(path => path.endsWith('/overview'))).toBe(false)
  expect(screen.queryByRole('button', { name: 'Refresh data' })).toBeNull()
})

test.each([404, 503])('an unavailable refresh (%s) keeps navigation and waits for explicit recovery before loading latest evidence', async status => {
  const reads: URL[] = []
  vi.stubGlobal('fetch', async (request: Request) => {
    const url = new URL(request.url)
    reads.push(url)
    if (url.pathname.endsWith('/context')) return json(context)
    if (url.pathname.endsWith('/profiles')) return json({ profiles: [simple, advanced] })
    if (url.pathname.endsWith('/runs/missing')) return json({ error: { code: status === 404 ? 'NOT_FOUND' : 'SERVICE_UNAVAILABLE', message: status === 404 ? 'SEO refresh not found.' : 'Refresh history is temporarily unavailable.' } }, status)
    if (url.pathname.endsWith('/overview')) return json(overview(simple))
    if (url.pathname.endsWith('/ranked-keywords')) return json({ runId: saved.id, total: 1, limit: 25, offset: 0, items: [ranked] })
    throw new Error(`Unexpected refresh recovery request ${request.method} ${url.pathname}`)
  })
  const { client, router } = await mount(simple.id, 'missing')
  await screen.findByRole('button', { name: 'Retry' })
  await waitFor(() => expect(client.isFetching()).toBe(0))
  expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'SEO profile' }).value).toBe(simple.id)
  expect(router.state.location.search.seoRunId).toBe('missing')
  expect(reads.some(url => url.pathname.endsWith('/overview'))).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'View latest data' }))
  await screen.findByText('saved keyword')
  expect(router.state.location.search.seoRunId).toBeUndefined()
  expect(router.state.location.search.seoProfileId).toBe(simple.id)
  expect(reads.filter(url => url.pathname.endsWith('/overview')).map(url => Object.fromEntries(url.searchParams))).toEqual([{ profileId: 'simple' }])
})

test('editing a profile preserves the datasets and locale of its prior saved evidence', async () => {
  const edited: SeoProfile = { ...simple, revision: 2, capabilities: ['domain-intelligence'], locationCode: 2250, languageCode: 'fr' }
  vi.stubGlobal('fetch', async (request: Request) => {
    const url = new URL(request.url)
    if (url.pathname.endsWith('/context')) return json(context)
    if (url.pathname.endsWith('/profiles')) return json({ profiles: [edited] })
    if (url.pathname.endsWith('/overview')) return json({ ...overview(edited), evidenceRun: { ...saved, capabilities: ['ranked-keywords'] } })
    if (url.pathname.endsWith('/ranked-keywords')) return json({ runId: saved.id, total: 1, limit: 25, offset: 0, items: [ranked] })
    throw new Error(`Unexpected current-profile dataset read ${url.pathname}`)
  })
  await mount()
  await screen.findByText('saved keyword')
  expect(screen.getByRole('button', { name: 'Ranked keywords' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.queryByRole('button', { name: 'Domain comparison' })).toBeNull()
  expect(screen.getByRole('status').textContent).toBe('Saved data uses profile revision 1 · Location 2840 · en. The current profile has changed.')
})

test.each(['advanced', 'simple'])('a historical link preserves its refresh identity or refuses a mismatched %s profile', async profileId => {
  const reads: URL[] = []
  const historic = { ...saved, id: 'historic', profileId: advanced.id, scope: advanced.scope, profileRevision: 1, locationCode: 2250, languageCode: 'fr' }
  vi.stubGlobal('fetch', async (request: Request) => {
    const url = new URL(request.url)
    reads.push(url)
    if (url.pathname.endsWith('/context')) return json(context)
    if (url.pathname.endsWith('/profiles')) return json({ profiles: [simple, advanced] })
    if (url.pathname.endsWith('/runs/historic')) return json({ ...historic, tasks: [], results: { keywordMetrics: [], rankedKeywords: [], domainIntelligence: [] }, resultCounts: { keywordMetrics: 0, rankedKeywords: 0, domainIntelligence: 0 }, resultsTruncated: false })
    if (url.pathname.endsWith('/overview')) return json({ ...overview(advanced, historic), evidenceRunId: historic.id, evidenceRun: historic })
    if (url.pathname.endsWith('/runs')) return json({ runs: [historic] })
    throw new Error(`Unexpected request ${url.pathname}`)
  })
  await mount(profileId, historic.id)
  if (profileId === 'simple') {
    await screen.findByRole('heading', { name: 'Refresh belongs to another profile' })
    expect(reads.some(url => url.pathname.endsWith('/overview'))).toBe(false)
  } else {
    await screen.findByText('Viewing saved refresh historic.')
    expect(screen.getByRole('button', { name: 'View latest data' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: 'Refresh data' })).toBeNull()
    expect(reads.find(url => url.pathname.endsWith('/overview'))?.searchParams.get('runId')).toBe('historic')
  }
})
