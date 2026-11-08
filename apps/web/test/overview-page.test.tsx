import { afterEach, beforeAll, expect, onTestFinished, test } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { getApiV1ProjectsQueryKey, getApiV1RunsQueryKey } from '@canonry/canonry-api-client/react-query'
import { projectDtoSchema, projectOverviewDtoSchema, whatChangedProjectItems, type ProjectDto, type ProjectOverviewWhatChangedDto } from '@canonry/canonry-contracts'

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
const BETA = projectDtoSchema.parse({ id: 'proj_beta', name: 'beta', displayName: 'Beta Roofing', canonicalDomain: 'beta.example', country: 'US', language: 'en' })

/** A project overview, valid against the server's own schema, carrying the given `whatChanged`. */
function overviewWith(project: ProjectDto, whatChanged: ProjectOverviewWhatChangedDto) {
  const score = { label: 'Not measured', value: 'No data', delta: '', tone: 'neutral', description: '', trend: [] }
  const mentionShareBase = { projectMentionSnapshots: 0, competitorMentionSnapshots: 0, combinedMentionSnapshots: 0, perCompetitor: [], ranking: [], snapshotsWithAnswerText: 0, snapshotsTotal: 0, score: null }
  const movement = { gained: 0, lost: 0, tone: 'neutral', hasPreviousRun: false }
  return projectOverviewDtoSchema.parse({
    project, latestRun: { totalRuns: 0, run: null }, health: null, topInsights: [],
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

/** The server's `whatChanged` for a checked project with these counts, its rows built as the server builds them. */
function whatChanged(project: ProjectDto, counts: { mentions?: number; citations?: number; activeRunIds?: string[] } = {}): ProjectOverviewWhatChangedDto {
  const lost = (queryCount: number) => ({ queryCount, queries: [], truncated: false })
  const activeRunIds = counts.activeRunIds ?? []
  return {
    mode: 'simple',
    latestCheck: { runIds: ['run_latest'], createdAt: '2026-09-08T00:00:00.000Z' },
    comparison: { state: 'available', previousRunIds: ['run_previous'] },
    lostMentions: lost(counts.mentions ?? 0),
    lostCitations: lost(counts.citations ?? 0),
    activeRuns: { count: activeRunIds.length, runIds: activeRunIds },
    items: whatChangedProjectItems(project, { lostMentionQueries: counts.mentions ?? 0, lostCitationQueries: counts.citations ?? 0, activeRuns: activeRunIds.length }),
  }
}

/**
 * Opens Overview through the real dashboard reads, answering each from the
 * current fixtures. `whatChanged` returning null fails that project's overview.
 */
async function renderOverviewOf(read: {
  projects?: ProjectDto[]
  runs: () => unknown[]
  whatChanged: (project: ProjectDto) => ProjectOverviewWhatChangedDto | null
}) {
  const projects = read.projects ?? [ACME]
  let overviewReads = 0
  let holding = false
  const held: Array<() => void> = []
  const restore = mockFetch((url) => {
    const path = pathOf(url).split('?')[0]
    if (path === '/api/v1/projects') return jsonResponse(projects)
    if (path === '/api/v1/runs') return jsonResponse(read.runs())
    const project = projects.find(candidate => path === `/api/v1/projects/${candidate.name}/overview`)
    if (project) {
      overviewReads += 1
      const respond = () => {
        const changes = read.whatChanged(project)
        return changes === null
          ? jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'Overview unavailable' } }, 500)
          : jsonResponse(overviewWith(project, changes))
      }
      return holding ? new Promise<Response>(resolve => { held.push(() => resolve(respond())) }) : respond()
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
  const refetchRuns = () => act(async () => {
    await queryClient.refetchQueries({ queryKey: getApiV1RunsQueryKey({ client: heyClient, query: { kind: 'answer-visibility' } }) })
  })
  return {
    whatChangedRows,
    refetchRuns,
    overviewReads: () => overviewReads,
    holdOverviewReads: () => { holding = true },
    heldOverviewReads: () => held.length,
    releaseOverviewReads: () => { holding = false; held.splice(0).forEach(release => release()) },
  }
}

// The page loads no answer evidence, so rows derived in the browser could
// never report a lost mention or citation. It lists what each overview says.
test('What changed lists the rows each project\'s overview reports, in order', async () => {
  const { whatChangedRows } = await renderOverviewOf({ runs: () => [], whatChanged: project => whatChanged(project, { mentions: 2, citations: 1 }) })

  await waitFor(() => expect(whatChangedRows()).toEqual([
    { title: 'Acme Coatings lost mentions', detail: '2 queries lost a mention in the latest check.', href: '/projects/acme' },
    { title: 'Acme Coatings lost citations', detail: '1 query lost a citation in the latest check.', href: '/projects/acme' },
  ]))
})

// Runs in progress come from the polled run list, so queuing or starting a
// run reads no overview. A finished sweep reads it once, and the page keeps
// the last rows meanwhile rather than blanking to its skeleton.
test('runs in progress come from the run list, and only a finished sweep reads the overview again', async () => {
  const sweep = { id: 'run_live', projectId: ACME.id, kind: 'answer-visibility', trigger: 'manual', location: null, startedAt: '2026-09-09T00:00:00.000Z', error: null, createdAt: '2026-09-09T00:00:00.000Z' }
  let runs: unknown[] = []
  let finished = false
  const { whatChangedRows, refetchRuns, overviewReads, holdOverviewReads, heldOverviewReads, releaseOverviewReads } = await renderOverviewOf({
    runs: () => runs,
    whatChanged: project => whatChanged(project, finished ? { mentions: 1 } : {}),
  })
  await waitFor(() => expect(whatChangedRows().map(row => row.title)).toEqual(['All projects stable']))
  const readsBefore = overviewReads()

  runs = [{ ...sweep, status: 'running', finishedAt: null }]
  await refetchRuns()
  await waitFor(() => expect(whatChangedRows()).toEqual([
    { title: 'Acme Coatings has active runs', detail: '1 run in progress.', href: '/runs' },
  ]))
  expect(overviewReads()).toBe(readsBefore)

  runs = [{ ...sweep, status: 'completed', finishedAt: '2026-09-09T00:05:00.000Z' }]
  finished = true
  holdOverviewReads()
  await refetchRuns()
  await waitFor(() => expect(heldOverviewReads()).toBe(1))
  expect(whatChangedRows().map(row => row.title)).toEqual(['All projects stable'])

  await act(async () => { releaseOverviewReads() })
  await waitFor(() => expect(whatChangedRows()).toEqual([
    { title: 'Acme Coatings lost mentions', detail: '1 query lost a mention in the latest check.', href: '/projects/acme' },
  ]))
  expect(overviewReads()).toBe(readsBefore + 1)
})

// A project whose overview failed has unknown changes, so the portfolio is
// never called clear: the project is named instead.
test('What changed names a project whose overview could not be read', async () => {
  const { whatChangedRows } = await renderOverviewOf({
    projects: [ACME, BETA],
    runs: () => [],
    whatChanged: project => project.id === ACME.id ? null : whatChanged(project),
  })

  await waitFor(() => expect(whatChangedRows()).toEqual([
    { title: '1 project couldn\'t be loaded', detail: 'Acme Coatings. Its lost mentions and citations are unknown.', href: null },
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
