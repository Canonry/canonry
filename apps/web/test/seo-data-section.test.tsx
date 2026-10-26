import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { SeoRunStatuses, type ScheduleDto, type SeoContext, type SeoMarketRanking, type SeoMarketRankingCounts, type SeoMarketRankingSummary, type SeoOverview, type SeoProfile, type SeoProfileInput, type SeoProvenance, type SeoRankedKeyword, type SeoRun } from '@canonry/canonry-contracts'
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
    keywordMetricsCount: 1, domainIntelligenceCount: 1, rankedKeywordCount: 1, marketRankingCount: 0,
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

async function mount(profileId: string | null = 'simple', runId?: string, extra: Record<string, string> = {}) {
  const client = createQueryClient()
  client.setDefaultOptions({ queries: { retry: false, gcTime: 0, staleTime: Infinity }, mutations: { retry: false } })
  clients.push(client)
  const text = (value: unknown) => typeof value === 'string' && value ? value : undefined
  const root = createRootRoute({
    validateSearch: (search: Record<string, unknown>) => ({
      seoProfileId: text(search.seoProfileId), seoRunId: text(search.seoRunId), seoRegion: text(search.seoRegion), seoMarket: text(search.seoMarket),
      seoShow: text(search.seoShow), seoSort: text(search.seoSort), seoQ: text(search.seoQ),
    }),
  })
  const route = createRoute({ getParentRoute: () => root, path: '/projects/$projectName/seo-data', component: () => <SeoDataSection projectName="example" /> })
  const search = new URLSearchParams()
  if (profileId) search.set('seoProfileId', profileId)
  if (runId) search.set('seoRunId', runId)
  for (const [key, value] of Object.entries(extra)) search.set(key, value)
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
  const table = await screen.findByRole('table', { name: 'Searches you rank for, from the selected refresh' })
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
    const freshness = screen.getByText(/^Updated/)
    expect(freshness.querySelector('time')?.getAttribute('datetime')).toBe(selectedFinishedAt)
    expect(freshness.querySelector('time')?.textContent).toMatch(/^Oct 18\b/)
    // A partial refresh with no failed task says so in a caveat, the sentence in its tooltip.
    expect(screen.queryByRole('button', { name: 'Partial results: some tasks returned only part of their results or did not run. Open Activity for details.' }) !== null).toBe(status === SeoRunStatuses.partial)
  } else {
    expect(screen.getByText('No completed refresh')).not.toBeNull()
    expect(screen.queryByText(/^Updated/)).toBeNull()
  }
})

test.each([{ hasSavedProfile: false, demo: false }, { hasSavedProfile: true, demo: false }, { hasSavedProfile: true, demo: true }])('unconfigured SEO preserves evidence and offers setup only outside demos ($hasSavedProfile, $demo)', async ({ hasSavedProfile, demo }) => {
  if (demo) window.__CANONRY_CONFIG__ = { demo: { enabled: true, readOnly: true, sampleData: true } }
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
    expect(screen.getByRole('heading', { name: 'SEO', exact: true })).toBeTruthy()
    if (demo) {
      expect(screen.queryByRole('button', { name: 'Refresh data' })).toBeNull()
      expect(screen.queryByText(reason)).toBeNull()
      expect(screen.getByText(/Fictional demo data/)).toBeTruthy()
    } else {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh data' }).disabled).toBe(true)
      expect(screen.getAllByText(reason).length).toBeGreaterThan(0)
    }
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
  expect(dataset('Searches you rank for').checked).toBe(true)
  fireEvent.change(within(form).getByRole('combobox', { name: 'Measurement scope' }), { target: { value: 'property:property-docs' } })
  expect(dataset('Searches you rank for').disabled).toBe(true)
  expect(dataset('Searches you rank for').checked).toBe(false)
  expect(dataset('Search demand').checked).toBe(true)
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
      keywordMetricsCount: 0, domainIntelligenceCount: 0, rankedKeywordCount: 0, marketRankingCount: 0,
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
  for (const label of ['Searches you rank for', 'Domain comparison']) {
    const checkbox = within(form).getByRole<HTMLInputElement>('checkbox', { name: label })
    if (checkbox.checked) fireEvent.click(checkbox)
  }
  const keywords = within(form).getByRole<HTMLInputElement>('checkbox', { name: 'Search demand' })
  if (!keywords.checked) fireEvent.click(keywords)
  expect(within(form).queryByRole('group', { name: 'Targets' })).toBeNull()
  expect(within(form).queryByRole('spinbutton', { name: 'Ranked searches per target' })).toBeNull()
  fireEvent.change(within(form).getByRole('textbox', { name: /^Searches/ }), { target: { value: 'solar installer\nhome solar cost' } })
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
  expect(screen.queryByRole('button', { name: 'Refresh data' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'New profile' })).toBeNull()
  fireEvent.click(screen.getByText('Details', { selector: 'summary' }))
  expect(screen.getByText('$2.31', { exact: false })).not.toBeNull()
  // The dataset is named by its kind; the vendor behind the host's source never reaches the client.
  expect(within(screen.getByRole('table')).getByText('Dataset').nextElementSibling!.textContent).toBe('Searches you rank for')
  expect(document.body.textContent).not.toMatch(/request cost|budget|billing|receipt|spend|dataforseo/i)
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
  expect(screen.getByRole('button', { name: 'Searches you rank for' }).getAttribute('aria-pressed')).toBe('true')
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
    if (url.pathname.endsWith('/runs/historic')) return json({ ...historic, tasks: [], results: { keywordMetrics: [], rankedKeywords: [], domainIntelligence: [], marketRankings: [] }, resultCounts: { keywordMetrics: 0, rankedKeywords: 0, domainIntelligence: 0, marketRankings: 0 }, resultsTruncated: false })
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

const markets: SeoProfile = {
  ...simple, id: 'markets', name: 'Market rankings', capabilities: ['market-rankings'], keywords: [], revision: 2,
  rankings: { locations: [{ key: 'metro', locationCode: 200623, label: 'Dallas-Ft. Worth, TX' }], depth: 50, device: 'mobile', searchText: 'query-without-market-region' },
}
const marketContext: SeoContext = {
  ...context,
  connections: [{ ...context.connections[0]!, capabilities: ['ranked-keywords', 'keyword-metrics', 'domain-intelligence', 'market-rankings'] }],
  scopes: [{ ...context.scopes[0]!, capabilities: ['ranked-keywords', 'keyword-metrics', 'domain-intelligence', 'market-rankings'] }],
}
// The saved refresh ran under revision 1; two of its ten searches failed.
const marketRun: SeoRun = { ...saved, id: 'saved-markets', profileId: 'markets', status: 'partial', capabilities: ['market-rankings'], scope: markets.scope, taskCount: 10, completedTasks: 8, failedTasks: 2, finishedAt: '2026-10-25T20:00:00Z' }
const nextRefresh: ScheduleDto = { id: 'seo-schedule', projectId: 'project-id', kind: 'seo-sync', cronExpr: '', recurrence: { everyDays: 14, startDate: '2026-11-08', time: '09:00' }, timezone: 'UTC', enabled: true, providers: [], nextRunAt: '2026-11-08T09:00:00.000Z', createdAt: source.collectedAt, updatedAt: source.collectedAt }
const marketSource: SeoProvenance = { ...source, dataset: 'dataforseo-serp/google/market-rankings', locationCode: 200623, device: 'mobile' }
const counts = (values: Partial<SeoMarketRankingCounts>): SeoMarketRankingCounts => ({ queries: 0, page1: 0, ranks11To20: 0, ranks21Plus: 0, notRanked: 0, partlyChecked: 0, failed: 0, notRun: 0, needsWork: 0, rivalAhead: 0, ...values })
// Every figure differs, so a value shown under the wrong label fails.
const totals = counts({ queries: 18, page1: 2, ranks11To20: 3, ranks21Plus: 1, notRanked: 4, partlyChecked: 6, failed: 2, needsWork: 14, rivalAhead: 5 })
const regions: SeoMarketRankingSummary['groups'] = ['Coast', 'Desert', 'Lake', 'Mountain', 'Prairie', 'Valley'].map((name, index) => ({
  key: name.toLowerCase(), label: `${name} Metro`, kind: 'region' as const, counts: counts({ queries: 10 + index, ranks11To20: 6 - index, rivalAhead: index * 2 }),
}))
function marketRow(queryText: string, values: Partial<SeoMarketRanking> = {}): SeoMarketRanking {
  return {
    marketKey: 'harbor', marketLabel: 'Harbor, Coast', regionKey: 'coast', regionLabel: 'Coast Metro', queryId: queryText, queryText, queryClass: 'non-brand',
    searchText: queryText, locationLabel: 'Harbor, TX', target: markets.targets[0]!, rankOrganic: null, rankAbsolute: null, url: null, depth: 50, checkedDepth: 50,
    searchStatus: 'completed', outcome: 'not-ranked', rivalAhead: false, competitors: [], provenance: marketSource, ...values,
  }
}
const marketRows = [
  marketRow('apartments near the harbor', { rankOrganic: 11, rankAbsolute: 14, url: 'https://example.com/harbor', outcome: 'ranks-11-20', rivalAhead: true, competitors: [{ domain: 'rival.com', rankOrganic: 3 }, { domain: 'other.com', rankOrganic: 30 }] }),
  marketRow('lofts with parking', { checkedDepth: 30, searchStatus: 'partial', outcome: 'partly-checked' }),
  marketRow('pet friendly lofts', { outcome: 'failed', searchStatus: 'failed', checkedDepth: 0, provenance: null }),
]

/** A market-rankings profile's reads; `summaryFor` answers each summary request, and every read is recorded. */
function stubMarkets(summaryFor: (url: URL) => SeoMarketRankingSummary, extra: (request: Request, url: URL) => Promise<Response> | null = () => null) {
  const reads: URL[] = []
  const writes: unknown[] = []
  vi.stubGlobal('fetch', async (request: Request) => {
    const url = new URL(request.url)
    if (request.method === 'PUT') { writes.push(await request.json()); return json({ ...markets, revision: 3 }) }
    reads.push(url)
    const handled = extra(request, url)
    if (handled) return handled
    if (url.pathname.endsWith('/context')) return json(marketContext)
    if (url.pathname.endsWith('/profiles')) return json({ profiles: [markets] })
    if (url.pathname.endsWith('/schedule')) return json(nextRefresh)
    if (url.pathname.endsWith('/overview')) return json({ ...overview(markets, marketRun), evidenceRunId: marketRun.id, evidenceRun: marketRun, summary: null, marketRankingCount: 18 })
    if (url.pathname.endsWith('/market-rankings/summary')) return json(summaryFor(url))
    if (url.pathname.endsWith('/market-rankings')) {
      const items = url.searchParams.get('q') === 'nothing like this' ? [] : marketRows
      return json({ runId: marketRun.id, total: items.length, limit: 10, offset: 0, items })
    }
    throw new Error(`Unexpected request ${request.method} ${url.pathname}`)
  })
  const lastRead = (path: string) => Object.fromEntries(reads.filter(url => url.pathname.endsWith(path)).at(-1)!.searchParams)
  return { reads, writes, lastRead }
}
const summary = (values: Partial<SeoMarketRankingSummary> = {}): SeoMarketRankingSummary => ({ runId: marketRun.id, depth: 50, regionKey: null, marketKey: null, regionLabel: null, marketLabel: null, totals, groups: regions, ...values })

test('market rankings lead with the refresh, then server counts by outcome and the regions to open', async () => {
  const { lastRead } = stubMarkets(url => url.searchParams.get('regionKey') === 'coast'
    ? summary({ regionKey: 'coast', regionLabel: 'Coast Metro', totals: counts({ queries: 3, ranks11To20: 1, notRanked: 1, failed: 1, needsWork: 2, rivalAhead: 1 }), groups: [
      { key: 'harbor', label: 'Harbor, Coast', kind: 'market', counts: counts({ queries: 2, ranks11To20: 1, notRanked: 1, needsWork: 2, rivalAhead: 1 }) },
      { key: 'bayside', label: 'Bayside, Coast', kind: 'market', counts: counts({ queries: 1, failed: 1 }) },
    ] })
    : summary())
  const { router } = await mount('markets')
  const figures = await screen.findByRole('region', { name: 'Google rank' })
  // The caption names what the rank figures leave out, so they reconcile with the total.
  expect(within(figures).getByText('18 queries · 6 partly checked · 2 failed')).not.toBeNull()
  // Freshness, the next scheduled refresh and the failed searches share one line, the sentence behind a caveat.
  const freshness = screen.getByText(/^Updated/)
  expect([...freshness.querySelectorAll('time')].map(time => [time.getAttribute('datetime'), /^(?:Oct 25|Nov 8)\b/.test(time.textContent ?? '')])).toEqual([['2026-10-25T20:00:00Z', true], ['2026-11-08T09:00:00.000Z', true]])
  expect(screen.getByRole('button', { name: '2 searches failed: 2 of 10 searches in this refresh returned no results. Their queries show as Failed.' })).not.toBeNull()
  expect(lastRead('/schedule')).toEqual({ kind: 'seo-sync' })
  const values = within(figures).getAllByRole('definition')
  expect(within(figures).getAllByRole('term').map((term, index) => [term.textContent, values[index]!.textContent])).toEqual([
    ['Page 1', '2'], ['11-20', '3'], ['21-50', '1'], ['Not in top 50', '4'], ['Rival ahead', '5'],
  ])
  expect(lastRead('/market-rankings/summary')).toEqual({ profileId: 'markets', runId: 'saved-markets' })

  // Regions arrive in the API's order, five at a time; a header re-sorts them.
  const regionTable = screen.getByRole('table', { name: 'Google rank by region' })
  const regionNames = () => within(regionTable).getAllByRole('rowheader').map(cell => cell.textContent)
  expect(regionNames()).toEqual(['Coast Metro', 'Desert Metro', 'Lake Metro', 'Mountain Metro', 'Prairie Metro'])
  expect(within(within(regionTable).getAllByRole('row')[1]!).getAllByRole('cell').map(cell => cell.textContent)).toEqual(['10', '0', '6', '0', '0', '0', ''])
  expect(screen.getByText('1 to 5 of 6 regions')).not.toBeNull()
  fireEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]!)
  expect(regionNames()).toEqual(['Valley Metro'])
  fireEvent.click(within(regionTable).getByRole('button', { name: 'Rival ahead' }))
  expect(regionNames()).toEqual(['Valley Metro', 'Prairie Metro', 'Mountain Metro', 'Lake Metro', 'Desert Metro'])
  expect(within(regionTable).getByRole('button', { name: 'Rival ahead' }).closest('th')!.getAttribute('aria-sort')).toBe('descending')

  // Opening a region puts it in the URL and reads its markets.
  fireEvent.click(within(regionTable).getByRole('link', { name: 'Desert Metro' }))
  await waitFor(() => expect(router.state.location.search).toMatchObject({ seoProfileId: 'markets', seoRegion: 'desert' }))
  fireEvent.click(await screen.findByRole('link', { name: 'All markets' }))
  await waitFor(() => expect(router.state.location.search.seoRegion).toBeUndefined())
  await router.navigate({ to: '/projects/$projectName/seo-data', params: { projectName: 'example' }, search: { seoProfileId: 'markets', seoRegion: 'coast' } })
  const trail = await screen.findByRole('navigation', { name: 'Market rankings scope' })
  expect(within(trail).getByText('Coast Metro').getAttribute('aria-current')).toBe('page')
  const marketTable = screen.getByRole('table', { name: 'Google rank by market' })
  expect(within(marketTable).getAllByRole('rowheader').map(cell => cell.textContent)).toEqual(['Harbor, Coast', 'Bayside, Coast'])
  expect(screen.getByText('3 queries · 1 failed')).not.toBeNull()
  await waitFor(() => expect(lastRead('/market-rankings')).toMatchObject({ regionKey: 'coast', outcome: 'needs-work' }))
  fireEvent.click(within(marketTable).getByRole('link', { name: 'Harbor, Coast' }))
  await waitFor(() => expect(router.state.location.search).toMatchObject({ seoRegion: 'coast', seoMarket: 'harbor' }))
})

test('queries open on what needs work, closest to page 1, and every filter, order and search is an API read kept in the URL', async () => {
  const { lastRead } = stubMarkets(() => summary())
  const { router } = await mount('markets')
  const table = await screen.findByRole('table', { name: 'Queries: Needs work' })
  expect(lastRead('/market-rankings')).toEqual({ profileId: 'markets', runId: 'saved-markets', outcome: 'needs-work', sort: 'rank', limit: '10', offset: '0' })
  const show = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Show queries' })
  // Not searched has no rows, so it is not offered.
  expect([...show.options].map(option => option.textContent)).toEqual(['Needs work (14)', 'Page 1 (2)', '11-20 (3)', '21-50 (1)', 'Not in top 50 (4)', 'Rival ahead (5)', 'Partly checked (6)', 'Failed (2)', 'All (18)'])
  // A settled result is announced once, politely.
  const announced = () => screen.getAllByRole('status').map(status => status.textContent)
  expect(announced()).toContain('3 queries: Needs work')

  const [ranked, partial, failed] = within(table).getAllByRole('row').slice(1)
  expect(within(ranked!).getAllByRole('cell')[0]!.textContent).toBe('11')
  expect(within(ranked!).getAllByRole('cell')[1]!.textContent).toBe('rival.com#3Ahead')
  expect(within(partial!).getAllByRole('cell')[0]!.textContent).toBe('Not in top 30')
  expect(within(partial!).getByRole('button', { name: 'Only the top 30 of 50 results came back for this search, so ranks past 30 are unknown.' })).not.toBeNull()
  expect(within(partial!).getAllByRole('cell')[1]!.textContent).toBe('None in top 30')
  expect(within(failed!).getByRole('button', { name: 'Failed: the source returned no results for this search in this refresh.' })).not.toBeNull()
  expect(within(failed!).getAllByRole('cell')[1]!.textContent).toBe('—No result')
  // Details open in a full-width row under the query, the ranking page first and linked.
  const open = (row: HTMLElement, query: string) => {
    const button = within(row).getByRole('button', { name: new RegExp(`^Details\\s*for ${query} in Harbor, Coast$`) })
    fireEvent.click(button)
    expect(button.getAttribute('aria-expanded')).toBe('true')
    const details = document.getElementById(button.getAttribute('aria-controls')!)!
    expect(details.querySelector('td')!.getAttribute('colspan')).toBe('4')
    return details
  }
  const rankedDetails = open(ranked!, 'apartments near the harbor')
  expect(within(rankedDetails).getByRole('link', { name: 'https://example.com/harbor' }).getAttribute('href')).toBe('https://example.com/harbor')
  expect(within(rankedDetails).getByText('Position on the page, counting maps and other blocks').nextElementSibling!.textContent).toBe('14')
  expect([...within(rankedDetails).getByText('Tracked competitors in these results').nextElementSibling!.children].map(item => item.textContent)).toEqual(['rival.com', '#3', 'other.com', '#30'])
  expect(within(rankedDetails).getByText('Dataset').nextElementSibling!.textContent).toBe('Market rankings')
  const failedDetails = open(failed!, 'pet friendly lofts')
  expect(within(failedDetails).getByText('Ranking page').nextElementSibling!.textContent).toBe('No result: the search failed')
  expect(within(failedDetails).queryByText('Dataset')).toBeNull()
  expect(within(open(partial!, 'lofts with parking')).getByText('Results checked').nextElementSibling!.textContent).toBe('Top 30 of 50')

  fireEvent.click(within(table).getByRole('button', { name: 'Google rank' }))
  await waitFor(() => expect(lastRead('/market-rankings')).toMatchObject({ sort: '-rank', outcome: 'needs-work' }))
  expect(within(table).getByRole('button', { name: 'Google rank' }).closest('th')!.getAttribute('aria-sort')).toBe('descending')
  fireEvent.change(show, { target: { value: 'failed' } })
  await waitFor(() => expect(lastRead('/market-rankings')).toMatchObject({ outcome: 'failed', sort: '-rank', offset: '0' }))
  fireEvent.change(screen.getByRole('searchbox', { name: 'Find a query' }), { target: { value: 'nothing like this' } })
  await screen.findByRole('heading', { name: 'No queries match' })
  expect(lastRead('/market-rankings')).toMatchObject({ outcome: 'failed', q: 'nothing like this' })
  expect(announced()).toContain('No queries match')
  // The investigation is in the URL, without a history entry per change.
  await waitFor(() => expect(router.state.location.search).toMatchObject({ seoProfileId: 'markets', seoShow: 'failed', seoSort: '-rank', seoQ: 'nothing like this' }))
  expect(router.history.length).toBe(1)
  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }))
  await screen.findByRole('table', { name: 'Queries: All' })
  expect(lastRead('/market-rankings')).toEqual({ profileId: 'markets', runId: 'saved-markets', sort: '-rank', limit: '10', offset: '0' })
  expect(screen.getByRole<HTMLInputElement>('searchbox', { name: 'Find a query' }).value).toBe('')
  await waitFor(() => expect(router.state.location.search).toMatchObject({ seoShow: 'all', seoSort: '-rank' }))
  expect('seoQ' in router.state.location.search).toBe(false)
  // Filtering re-renders the view in place; the region table above it stays a single table.
  expect(screen.getAllByRole('table', { name: 'Google rank by region' })).toHaveLength(1)
})

test('a saved link reopens the same filter, order and search, and a new filter starts at the first page', async () => {
  const { lastRead } = stubMarkets(() => summary(), (_request, url) => url.pathname.endsWith('/market-rankings')
    ? Promise.resolve(json({ runId: marketRun.id, total: 25, limit: 10, offset: Number(url.searchParams.get('offset')), items: marketRows }))
    : null)
  await mount('markets', undefined, { seoShow: 'rival-ahead', seoSort: '-rank', seoQ: 'harbor' })
  await screen.findByRole('table', { name: 'Queries: Rival ahead' })
  expect(lastRead('/market-rankings')).toEqual({ profileId: 'markets', runId: 'saved-markets', outcome: 'rival-ahead', sort: '-rank', q: 'harbor', limit: '10', offset: '0' })
  expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Show queries' }).value).toBe('rival-ahead')
  expect(screen.getByRole<HTMLInputElement>('searchbox', { name: 'Find a query' }).value).toBe('harbor')
  fireEvent.click(screen.getAllByRole('button', { name: 'Next' }).at(-1)!)
  await waitFor(() => expect(lastRead('/market-rankings')).toMatchObject({ outcome: 'rival-ahead', offset: '10' }))
  fireEvent.change(screen.getByRole('combobox', { name: 'Show queries' }), { target: { value: 'failed' } })
  await waitFor(() => expect(lastRead('/market-rankings')).toMatchObject({ outcome: 'failed', offset: '0' }))
  // Returning to the earlier filter starts over too, rather than reopening its old page.
  fireEvent.change(screen.getByRole('combobox', { name: 'Show queries' }), { target: { value: 'rival-ahead' } })
  await waitFor(() => expect(lastRead('/market-rankings')).toMatchObject({ outcome: 'rival-ahead', offset: '0' }))
  expect(screen.getByText('1 to 3 of 25 queries')).not.toBeNull()
})

test('a scope with nothing off page 1 opens on every query', async () => {
  const { lastRead } = stubMarkets(() => summary({ totals: counts({ queries: 3, page1: 3 }), groups: [] }))
  await mount('markets')
  await screen.findByRole('table', { name: 'Queries: All' })
  expect(lastRead('/market-rankings')).toEqual({ profileId: 'markets', runId: 'saved-markets', sort: 'rank', limit: '10', offset: '0' })
  expect(screen.getByRole<HTMLSelectElement>('combobox', { name: 'Show queries' }).value).toBe('all')
  // A lone market would only repeat the queries, so there is no table of groups to open.
  expect(screen.queryByRole('table', { name: /^Google rank by/ })).toBeNull()
})

test('market-rankings activity counts searches, and editing the profile keeps its search settings', async () => {
  const search = (id: string, status: SeoRun['status'], error: string | null) => ({ id, capability: 'market-rankings' as const, target: markets.targets[0]!, status, error, remoteTaskId: null })
  const { writes } = stubMarkets(() => summary(), (_request, url) => {
    if (url.pathname.endsWith('/runs/saved-markets')) return Promise.resolve(json({ ...marketRun, tasks: [search('t1', 'completed', null), search('t2', 'failed', 'The source refused this search.'), search('t3', 'completed', null)], results: { keywordMetrics: [], rankedKeywords: [], domainIntelligence: [], marketRankings: [] }, resultCounts: { keywordMetrics: 0, rankedKeywords: 0, domainIntelligence: 0, marketRankings: 8 }, resultsTruncated: false }))
    if (url.pathname.endsWith('/runs')) return Promise.resolve(json({ runs: [marketRun] }))
    return null
  })
  await mount('markets')
  await screen.findByText('18 queries · 6 partly checked · 2 failed')
  expect(screen.getByText('1 search location · en')).not.toBeNull()
  // The saved refresh searched from each market's location, never the profile's one location code.
  expect(screen.getByText('Saved data uses profile revision 1 · Market locations · en. The current profile has changed.')).not.toBeNull()

  // Activity counts searches and lists only the one that did not complete.
  fireEvent.click(screen.getByRole('button', { name: 'Activity' }))
  expect(await screen.findByText('8 of 10 searches completed · 2 failed')).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /^Details\s*for refresh saved-markets$/ }))
  const details = await screen.findByText('The source refused this search.')
  const panel = details.closest('[id="seo-run-saved-markets"]') as HTMLElement
  expect(within(panel).getByText('Profile revision 1 · Market locations · en')).not.toBeNull()
  expect(within(panel).getAllByRole('listitem')).toHaveLength(1)

  fireEvent.click(screen.getByRole('button', { name: 'Edit profile' }))
  const form = screen.getByRole('form', { name: 'Edit SEO profile' })
  // Market rankings keep their own profile and report one target, so other datasets and a second target are unavailable.
  const demand = within(form).getByRole<HTMLInputElement>('checkbox', { name: 'Search demand' })
  expect(demand.disabled).toBe(true)
  expect(document.getElementById(demand.getAttribute('aria-describedby')!)?.textContent).toBe('Market rankings use their own profile.')
  expect(within(form).getByRole<HTMLInputElement>('checkbox', { name: 'Market rankings' }).disabled).toBe(false)
  expect(within(form).getByRole<HTMLButtonElement>('button', { name: 'Add target' }).disabled).toBe(true)
  fireEvent.change(within(form).getByRole('textbox', { name: 'Profile name' }), { target: { value: 'Markets by metro' } })
  fireEvent.click(within(form).getByRole('button', { name: 'Save profile' }))
  await waitFor(() => expect(writes).toHaveLength(1))
  expect(writes[0]).toMatchObject({ name: 'Markets by metro', capabilities: ['market-rankings'], targets: markets.targets, rankings: markets.rankings })
  fireEvent.click(screen.getByRole('button', { name: /New profile/ }))
  const created = screen.getByRole('form', { name: 'New SEO profile' })
  // Market-rankings setup (locations, depth, device) is not in the web editor yet.
  const marketsBox = within(created).getByRole<HTMLInputElement>('checkbox', { name: 'Market rankings' })
  expect(marketsBox.disabled).toBe(true)
  expect(document.getElementById(marketsBox.getAttribute('aria-describedby')!)?.textContent).toBe('Set up market rankings with the CLI or API.')
})
