import { afterEach, beforeAll, expect, onTestFinished, test } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { getApiV1ProjectsQueryKey, getApiV1RunsQueryKey } from '@canonry/canonry-api-client/react-query'
import { projectDtoSchema, projectOverviewDtoSchema, type ProjectOverviewWhatChangedDto } from '@canonry/canonry-contracts'

import { heyClient } from '../src/api.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { createAppRouter } from '../src/router/router.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

afterEach(() => {
  cleanup()
})

const projectsKey = getApiV1ProjectsQueryKey({ client: heyClient })

/**
 * Opens Overview with a project list the server cannot load. Counts its reads,
 * and can hold them in flight so the retrying state is observable.
 */
async function renderUnavailableOverview() {
  let projectReads = 0
  let holding = false
  const held: Array<() => void> = []
  const failure = () => jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Database unavailable' } }, 503)
  const restore = mockFetch((url) => {
    const path = pathOf(url)
    if (path === '/api/v1/projects') {
      projectReads += 1
      return holding ? new Promise<Response>(resolve => { held.push(() => resolve(failure())) }) : failure()
    }
    if (path.startsWith('/api/v1/runs')) return jsonResponse([])
    return jsonResponse({})
  })
  onTestFinished(restore)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/'] })
  await router.load()
  render(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={null}>
        <RouterProvider router={router} />
      </AccountProvider>
    </QueryClientProvider>,
  )
  return {
    queryClient,
    projectReads: () => projectReads,
    holdReads: () => { holding = true },
    releaseReads: () => { holding = false; held.splice(0).forEach(release => release()) },
  }
}

const ACME = projectDtoSchema.parse({ id: 'proj_acme', name: 'acme', displayName: 'Acme Coatings', canonicalDomain: 'acme.example', country: 'US', language: 'en' })

/** A project overview, valid against the server's own schema, carrying the given `whatChanged`. */
function overviewWith(whatChanged: ProjectOverviewWhatChangedDto) {
  const score = { label: 'Not measured', value: 'No data', delta: '', tone: 'neutral', description: '', trend: [] }
  const mentionShareBase = { projectMentionSnapshots: 0, competitorMentionSnapshots: 0, combinedMentionSnapshots: 0, perCompetitor: [], ranking: [], snapshotsWithAnswerText: 0, snapshotsTotal: 0, score: null }
  const movement = { gained: 0, lost: 0, tone: 'neutral', hasPreviousRun: false }
  return projectOverviewDtoSchema.parse({
    project: ACME, latestRun: { totalRuns: 0, run: null }, health: null, topInsights: [],
    queryCounts: { totalQueries: 0, citedQueries: 0, notCitedQueries: 0, citedRate: 0, mentionedQueries: 0, notMentionedQueries: 0, mentionRate: 0 },
    providers: [], transitions: { since: null, gained: 0, lost: 0, emerging: 0 },
    scores: {
      mention: score, visibility: score,
      mentionShare: { ...score, scope: 'non-brand', breakdown: mentionShareBase, branded: mentionShareBase },
      gapQueries: score, mentionGaps: score, indexCoverage: score, competitorPressure: score, runStatus: score,
    },
    movementSummary: movement, citationMovement: movement, mentionMovement: movement,
    movementComparison: { hasPreviousRun: false, comparable: false, querySetChanged: false, previousRunAt: null, currentQueryCount: 0, previousQueryCount: 0, comparableQueryCount: 0, addedQueryCount: 0, removedQueryCount: 0, addedQueries: [], removedQueries: [] },
    competitors: [], providerScores: [], attentionItems: [], whatChanged, runHistory: [],
    suggestedQueries: { rows: [], totalCandidates: 0, skippedAlreadyTracked: 0 }, dateRangeLabel: 'All time', contextLabel: 'US / EN',
  })
}

const NOTHING_LOST = { queryCount: 0, queries: [], truncated: false }

function whatChanged(items: ProjectOverviewWhatChangedDto['items'], activeRunIds: string[] = []): ProjectOverviewWhatChangedDto {
  return {
    mode: 'simple',
    latestCheck: { runIds: ['run_latest'], createdAt: '2026-09-08T00:00:00.000Z' },
    comparison: { state: 'available', previousRunIds: ['run_previous'] },
    lostMentions: NOTHING_LOST,
    lostCitations: NOTHING_LOST,
    activeRuns: { count: activeRunIds.length, runIds: activeRunIds },
    items,
  }
}

/** Opens Overview over one project through the real dashboard reads, answering each from the current fixtures. */
async function renderOverviewOf(read: { runs: () => unknown[]; whatChanged: () => ProjectOverviewWhatChangedDto }) {
  let holding = false
  const held: Array<() => void> = []
  const restore = mockFetch((url) => {
    const path = pathOf(url).split('?')[0]
    if (path === '/api/v1/projects') return jsonResponse([ACME])
    if (path === '/api/v1/runs') return jsonResponse(read.runs())
    if (path === '/api/v1/projects/acme/overview') {
      const overview = () => jsonResponse(overviewWith(read.whatChanged()))
      return holding ? new Promise<Response>(resolve => { held.push(() => resolve(overview())) }) : overview()
    }
    if (path === '/api/v1/settings') return jsonResponse({ providers: [] })
    return jsonResponse({})
  })
  onTestFinished(restore)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  const router = createAppRouter(queryClient, { initialEntries: ['/'] })
  await router.load()
  render(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={null}>
        <RouterProvider router={router} />
      </AccountProvider>
    </QueryClientProvider>,
  )
  const whatChangedRows = () => {
    const section = screen.getByRole('heading', { level: 2, name: 'What changed' }).closest('section')!
    return [...section.querySelectorAll('.attention-item')].map(row => ({
      title: row.querySelector('.attention-title')?.textContent,
      detail: row.querySelector('.attention-detail')?.textContent,
      href: row.getAttribute('href'),
    }))
  }
  return {
    queryClient,
    whatChangedRows,
    holdOverviewReads: () => { holding = true },
    heldOverviewReads: () => held.length,
    releaseOverviewReads: () => { holding = false; held.splice(0).forEach(release => release()) },
  }
}

// The page loads no answer evidence, so rows derived in the browser could
// never report a lost mention or citation. It lists what each overview says.
test('What changed lists the rows each project\'s overview reports, in order', async () => {
  const lostMentions = { id: 'attention_proj_acme_lost_mentions', tone: 'negative' as const, title: 'Acme Coatings lost mentions', detail: '2 queries lost a mention in the latest check.', actionLabel: 'Open project', href: '/projects/acme' }
  const lostCitations = { id: 'attention_proj_acme_lost', tone: 'negative' as const, title: 'Acme Coatings lost citations', detail: '1 query lost a citation in the latest check.', actionLabel: 'Open project', href: '/projects/acme' }
  const { whatChangedRows } = await renderOverviewOf({ runs: () => [], whatChanged: () => whatChanged([lostMentions, lostCitations]) })

  await waitFor(() => expect(whatChangedRows()).toEqual([
    { title: 'Acme Coatings lost mentions', detail: '2 queries lost a mention in the latest check.', href: '/projects/acme' },
    { title: 'Acme Coatings lost citations', detail: '1 query lost a citation in the latest check.', href: '/projects/acme' },
  ]))
})

// The runs in progress come from the overview too, so a run starting must
// read it again rather than wait for the run to finish, and the page keeps
// the last overview meanwhile instead of blanking to its skeleton.
test('a run starting refreshes What changed without waiting for it to finish', async () => {
  const running = { id: 'run_live', projectId: ACME.id, kind: 'answer-visibility', status: 'running', trigger: 'manual', location: null, startedAt: '2026-09-09T00:00:00.000Z', finishedAt: null, error: null, createdAt: '2026-09-09T00:00:00.000Z' }
  const active = { id: 'attention_proj_acme_active', tone: 'neutral' as const, title: 'Acme Coatings has active runs', detail: '1 run in progress.', actionLabel: 'View runs', href: '/runs' }
  let runs: unknown[] = []
  const { queryClient, whatChangedRows, holdOverviewReads, heldOverviewReads, releaseOverviewReads } = await renderOverviewOf({
    runs: () => runs,
    whatChanged: () => runs.length > 0 ? whatChanged([active], [running.id]) : whatChanged([]),
  })
  await waitFor(() => expect(whatChangedRows().map(row => row.title)).toEqual(['All projects stable']))

  runs = [running]
  holdOverviewReads()
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: getApiV1RunsQueryKey({ client: heyClient, query: { kind: 'answer-visibility' } }) })
  })
  await waitFor(() => expect(heldOverviewReads()).toBe(1))
  expect(whatChangedRows().map(row => row.title)).toEqual(['All projects stable'])

  await act(async () => { releaseOverviewReads() })
  await waitFor(() => expect(whatChangedRows()).toEqual([
    { title: 'Acme Coatings has active runs', detail: '1 run in progress.', href: '/runs' },
  ]))
})

// The failure keeps the destination's one name, the sidebar link's.
test('when the project list cannot load, the page is named Overview and offers a retry', async () => {
  await renderUnavailableOverview()

  expect(await screen.findByRole('heading', { level: 1, name: 'Overview unavailable' })).toBeTruthy()
  expect(screen.getByText('Canonry could not load the project list.')).toBeTruthy()
  expect(within(screen.getByRole('alert')).getByRole('button', { name: 'Retry loading projects' })).toBeTruthy()
  const sidebar = screen.getByRole('complementary', { name: 'Primary navigation' })
  expect(within(sidebar).getByRole('link', { name: 'Overview', exact: true }).getAttribute('href')).toBe('/')
})

// A failed read retries through `pending`. The shell used to swap the page for
// its skeleton then, and the page's remount retried at once: thousands of
// reads a second, with the failure never on screen.
test('a failed project list is read a bounded number of times, not in a loop', async () => {
  const { projectReads } = await renderUnavailableOverview()

  await screen.findByRole('heading', { level: 1, name: 'Overview unavailable' })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)) })
  // The route's check and the shell's and page's mounts read it three times;
  // the slack allows a 2s poll on a slow run. The loop read it thousands.
  expect(projectReads()).toBeLessThan(10)
})

test('Retry keeps the failure and focus in place while the read is retried', async () => {
  const { queryClient, projectReads, holdReads, releaseReads } = await renderUnavailableOverview()
  const retry = await screen.findByRole('button', { name: 'Retry loading projects' })
  await waitFor(() => expect(queryClient.getQueryState(projectsKey)?.fetchStatus).toBe('idle'))
  const readsBefore = projectReads()

  holdReads()
  retry.focus()
  fireEvent.click(retry)
  await waitFor(() => expect(projectReads()).toBeGreaterThan(readsBefore))
  // The query drops its error while the retry is in flight.
  expect(queryClient.getQueryState(projectsKey)?.status).toBe('pending')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)) })
  expect(screen.getByRole('heading', { level: 1, name: 'Overview unavailable' })).toBeTruthy()
  expect(document.activeElement).toBe(retry)

  releaseReads()
  await waitFor(() => expect(queryClient.getQueryState(projectsKey)?.status).toBe('error'))
  expect(screen.getByRole('heading', { level: 1, name: 'Overview unavailable' })).toBeTruthy()
  expect(document.activeElement).toBe(retry)
})
