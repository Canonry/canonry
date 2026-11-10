import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { RunKinds, onboardingTelemetryEventSchema, projectSetupDtoSchema, type ProjectSetupDto } from '@canonry/canonry-contracts'
import { getApiV1ProjectsByNameSetupQueryKey, getApiV1RunsQueryKey } from '@canonry/canonry-api-client/react-query'

import { heyClient } from '../src/api.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { getToasts } from '../src/lib/toast-store.js'
import { markOnboardingRunLaunched } from '../src/lib/onboarding-telemetry.js'
import { ProjectSetupTracker } from '../src/pages/ProjectSetupTracker.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

const navigate = vi.hoisted(() => vi.fn())

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => navigate,
    Link: ({ children, to, className }: { children: ReactNode; to: string; className?: string }) => <a href={to} className={className}>{children}</a>,
  }
})

// The panel's own steps run against the real panel in
// setup-ai-visibility-onboarding.test.tsx. Here it only hands the row back the
// way the panel does: Back closes it, and a launch reports the queued run.
vi.mock('../src/components/setup/AiVisibilitySetupPanel.js', () => ({
  AiVisibilitySetupPanel: ({ initialStep, hasBaseline, onClose, onLaunched }: { initialStep: string; hasBaseline?: boolean; onClose: () => void; onLaunched: (runId: string) => void }) => (
    <div data-testid="setup-panel" data-initial-step={initialStep} data-has-baseline={String(Boolean(hasBaseline))}>
      <h3>Panel step</h3>
      <button type="button" onClick={() => onClose()}>Back</button>
      <button type="button" onClick={() => onLaunched('panel-run')}>Run first check</button>
    </div>
  ),
}))

afterEach(() => {
  cleanup()
  navigate.mockReset()
  window.sessionStorage.clear()
})

const PROJECT = 'canonry-ai'

type SetupOverrides = {
  complete?: boolean
  agentReadiness?: Partial<ProjectSetupDto['tracks']['agentReadiness']>
  aiVisibility?: Partial<ProjectSetupDto['tracks']['aiVisibility']>
}

/** A setup read as the server returns it, validated by the contract so the fixture cannot drift from it. */
function setupRead(overrides: SetupOverrides = {}): ProjectSetupDto {
  return projectSetupDtoSchema.parse({
    project: { name: PROJECT, displayName: 'Canonry', canonicalDomain: 'https://www.Canonry.ai/' },
    complete: overrides.complete ?? false,
    firstResultAt: null,
    nextAction: 'run_agent_readiness',
    tracks: {
      agentReadiness: { state: 'not_started', runId: null, startedAt: null, finishedAt: null, progress: null, result: null, error: null, ...overrides.agentReadiness },
      aiVisibility: {
        state: 'not_started', runId: null, startedAt: null, finishedAt: null, baselineRunId: null, blockedBy: 'no_engine', engines: [],
        queries: { total: 0, nonBrand: 0, branded: 0, unclassified: 0 },
        progress: null, providerFailures: null, result: null, error: null, failedEngines: null,
        ...overrides.aiVisibility,
      },
    },
  })
}

function renderTracker(options: {
  setup: ProjectSetupDto | (() => Response)
  firstRun?: boolean
  /** The row a link named, as `?track=` carries it. */
  track?: 'agent-readiness' | 'ai-visibility'
  onRequest?: (path: string, init?: RequestInit) => Response | undefined
}) {
  const requests: Array<{ path: string; method?: string; body?: RequestInit['body'] }> = []
  const restore = mockFetch(async (url, init) => {
    const path = pathOf(url)
    requests.push({ path, method: init?.method, body: init?.body })
    const handled = options.onRequest?.(path, init)
    if (handled) return handled
    if (path === `/api/v1/projects/${PROJECT}/setup`) {
      return typeof options.setup === 'function' ? options.setup() : jsonResponse(options.setup)
    }
    if (path === `/api/v1/projects/${PROJECT}`) {
      return jsonResponse({ id: 'project-1', name: PROJECT, displayName: 'Canonry', canonicalDomain: 'canonry.ai', country: 'US', language: 'en' })
    }
    return jsonResponse({})
  })
  onTestFinished(restore)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={null}>
        <DashboardProvider value={createDashboardFixture()}>
          <ProjectSetupTracker projectName={PROJECT} firstRun={options.firstRun ?? true} track={options.track} />
        </DashboardProvider>
      </AccountProvider>
    </QueryClientProvider>,
  )
  return { requests, queryClient }
}

function rowOf(heading: HTMLElement, name: string): HTMLElement {
  const item = heading.closest('li')
  if (!item) throw new Error(`no tracker row for ${name}`)
  return item
}

function row(name: string): HTMLElement {
  return rowOf(screen.getByRole('heading', { level: 2, name }), name)
}

/** A row once the setup read has loaded; until then the page is a skeleton. */
async function findRow(name: string): Promise<HTMLElement> {
  return rowOf(await screen.findByRole('heading', { level: 2, name }), name)
}

/** The scan start needs the project's id, which a separate read supplies. */
async function findScanStart(): Promise<HTMLButtonElement> {
  const button = await within(await findRow('Agent Readiness')).findByRole('button', { name: 'Run audit scan' }) as HTMLButtonElement
  await waitFor(() => expect(button.disabled).toBe(false))
  return button
}

/** The tracker's two state announcements (audit scan, then AI Visibility check), outside the rows. */
function statusLines(): string[] {
  return screen.getAllByRole('status').filter(region => !region.closest('li')).map(region => region.textContent ?? '')
}

/** The view's filled (primary) buttons and links: setup allows exactly one. */
function primaryActions(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('button, a')].filter(element => element.classList.contains('bg-accent'))
}

test('a new project leads with the free audit scan and keeps AI Visibility beside it, with no optional or skipped steps', async () => {
  renderTracker({ setup: setupRead() })

  expect(await screen.findByRole('heading', { level: 1, name: 'Set up Canonry' })).toBeTruthy()
  // The stored domain is raw; the page shows the normalized host.
  expect(screen.getByText('Canonry · canonry.ai')).toBeTruthy()
  expect(within(row('Website')).getByText('canonry.ai · United States · English')).toBeTruthy()

  const scan = row('Agent Readiness')
  expect(within(scan).getByText('Not started')).toBeTruthy()
  const ai = row('AI Visibility')
  expect(within(ai).getByText('Whether AI answers mention Canonry and cite canonry.ai. Needs an AI engine.')).toBeTruthy()

  expect(primaryActions().map(action => action.textContent)).toEqual(['Run audit scan'])
  expect(within(ai).getByRole('button', { name: 'Connect an AI engine' }).classList.contains('bg-accent')).toBe(false)
  expect(screen.queryByText(/optional|skipped|skip/i)).toBeNull()
})

test('an existing project reads Project setup, not the first setup', async () => {
  renderTracker({ setup: setupRead(), firstRun: false })
  expect(await screen.findByRole('heading', { level: 1, name: 'Project setup' })).toBeTruthy()
})

test('while the AI Visibility check runs it shows the server progress and engine failures, and the scan is the one primary action', async () => {
  renderTracker({
    setup: setupRead({
      aiVisibility: {
        state: 'running', runId: 'run-ai', startedAt: '2026-11-10T04:02:00.000Z', blockedBy: null,
        engines: ['gemini', 'openai', 'claude'], queries: { total: 5, nonBrand: 4, branded: 1, unclassified: 0 },
        progress: { answersSaved: 6, answersPlanned: 15 },
        providerFailures: { gemini: { message: 'Quota exceeded for this API key.', failedQueries: 2, stopped: false } },
      },
    }),
  })

  const ai = await findRow('AI Visibility')
  const bar = within(ai).getByRole('progressbar', { name: 'AI Visibility check progress' })
  expect([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax')]).toEqual(['6', '15'])
  expect(within(ai).getByText('6 of 15 answers saved')).toBeTruthy()
  expect(within(ai).getByText('Gemini: 2 queries failed.')).toBeTruthy()
  expect(within(ai).getByText('You can leave this page. The check keeps running.', { exact: false })).toBeTruthy()
  expect(within(ai).getByText('4 non-brand · 1 branded')).toBeTruthy()
  // The check never offers a box for the other track: the scan's own row does.
  expect(screen.queryByText('Check Agent Readiness')).toBeNull()
  expect(primaryActions().map(action => action.textContent)).toEqual(['Run audit scan'])
})

test.each([
  // A site smaller than the cap: the bar measures the pages found, so it can fill.
  { pagesFound: 75, count: '10 of 75', max: '75' },
  // A site at or past the cap: the scan stops at the cap.
  { pagesFound: 240, count: '10 of up to 100', max: '100' },
])('a running audit scan with $pagesFound pages found counts its checked pages as "$count"', async ({ pagesFound, count, max }) => {
  renderTracker({
    setup: setupRead({
      agentReadiness: {
        state: 'running', runId: 'run-scan', startedAt: '2026-11-10T04:02:00.000Z',
        progress: { phase: 'checking', pagesFound, pagesChecked: 10, pageLimit: 100, linksFound: 414, pagesFailed: 0 },
      },
    }),
  })

  const scan = await findRow('Agent Readiness')
  const bar = within(scan).getByRole('progressbar', { name: 'Agent Readiness audit scan progress' })
  expect([bar.getAttribute('aria-valuenow'), bar.getAttribute('aria-valuemax')]).toEqual(['10', max])
  expect(within(scan).getByText('Checking pages')).toBeTruthy()
  expect(within(scan).getByText(count)).toBeTruthy()
  const details = within(scan).getByText('Scan details').closest('details')!
  expect(within(details).getByText('Links found').nextElementSibling?.textContent).toBe('414')
  // With the scan running, the next start is AI Visibility's.
  expect(primaryActions().map(action => action.textContent)).toEqual(['Connect an AI engine'])
})

test('before the first answer the check bar pulses instead of filling', async () => {
  renderTracker({
    setup: setupRead({ aiVisibility: { state: 'queued', runId: 'run-ai', blockedBy: null, progress: { answersSaved: 0, answersPlanned: null } } }),
  })
  const bar = within(await findRow('AI Visibility')).getByRole('progressbar', { name: 'AI Visibility check progress' })
  expect(bar.getAttribute('aria-valuenow')).toBeNull()
  expect(within(row('AI Visibility')).getByText('Waiting to start')).toBeTruthy()
})

test('with both results, setup reads complete, the exit is primary, and the first result keeps its query classes apart', async () => {
  renderTracker({
    setup: setupRead({
      complete: true,
      agentReadiness: { state: 'completed', runId: 'run-scan', finishedAt: '2026-11-10T04:03:00.000Z', result: { score: 83.6, pagesScored: 75 } },
      aiVisibility: {
        state: 'completed', runId: 'run-ai', finishedAt: '2026-11-10T04:04:00.000Z', baselineRunId: 'run-ai', blockedBy: null,
        engines: ['gemini'], queries: { total: 5, nonBrand: 4, branded: 1, unclassified: 0 },
        result: {
          first: true, answers: 5, engines: 1,
          queryCounts: { totalQueries: 5, citedQueries: 1, mentionedQueries: 2 },
          queryCountsByClass: {
            nonBrand: { totalQueries: 4, citedQueries: 0, mentionedQueries: 1 },
            branded: { totalQueries: 1, citedQueries: 1, mentionedQueries: 1 },
            unclassifiedQueries: 0,
          },
        },
      },
    }),
  })

  expect(await screen.findByText('Setup complete · Canonry · canonry.ai')).toBeTruthy()
  expect(primaryActions().map(action => action.textContent)).toEqual(['Open project'])
  // The score carries the same figure weight as the check results (83.6 rounds to 84).
  const score = within(row('Agent Readiness')).getByText('84')
  expect(score.classList.contains('text-heading-20')).toBe(true)
  expect(score.nextElementSibling?.textContent).toBe('of 100 · 75 pages scored')

  const ai = row('AI Visibility')
  expect(within(ai).getByText(/^Baseline · 5 answers from 1 engine/)).toBeTruthy()
  const table = within(ai).getByRole('table', { name: 'First AI Visibility check by query class' })
  const cells = (label: string) => [...within(table).getByRole('rowheader', { name: label }).closest('tr')!.querySelectorAll('td')].map(cell => cell.textContent)
  expect(cells('Non-brand')).toEqual(['1 of 4 queries', '0 of 4 queries'])
  expect(cells('Branded')).toEqual(['1 of 1 query', '1 of 1 query'])
  expect(screen.getByRole('heading', { name: 'What else this project can do' })).toBeTruthy()
  // What a screen reader hears when each track finishes: the score, and the answers and engines.
  expect(statusLines()).toEqual(['Agent Readiness audit scan complete. Score 84 of 100.', 'AI Visibility check complete. 5 answers from 1 engine.'])
})

test('a later check reads as the latest check, never as the baseline', async () => {
  renderTracker({
    setup: setupRead({
      complete: true,
      agentReadiness: { state: 'completed', runId: 'run-scan', result: { score: 80, pagesScored: 40 } },
      aiVisibility: {
        state: 'completed', runId: 'run-ai-2', finishedAt: '2026-11-12T04:04:00.000Z', baselineRunId: 'run-ai-1', blockedBy: null, engines: ['gemini'],
        result: { first: false, answers: 5, engines: 1, queryCounts: { totalQueries: 5, citedQueries: 1, mentionedQueries: 2 }, queryCountsByClass: null },
      },
    }),
  })

  const ai = await findRow('AI Visibility')
  expect(within(ai).getByText(/^Latest check · 5 answers from 1 engine/)).toBeTruthy()
  expect(within(ai).getByRole('table', { name: 'Latest AI Visibility check by query class' })).toBeTruthy()
  expect(within(ai).queryByText(/baseline/i)).toBeNull()
})

test.each([
  { baselineRunId: null, summary: 'The check did not finish. No baseline was saved.' },
  // A later check that fails leaves the project's results as they were.
  { baselineRunId: 'run-ai-1', summary: 'The check did not finish. Earlier results are unchanged.' },
] as const)('a check that failed says so and offers to run it again (baseline $baselineRunId)', async ({ baselineRunId, summary }) => {
  renderTracker({
    setup: setupRead({
      agentReadiness: { state: 'completed', runId: 'run-scan', result: { score: 70, pagesScored: 12 } },
      aiVisibility: { state: 'failed', runId: 'run-ai', baselineRunId, blockedBy: null, engines: ['openrouter'], error: 'OpenRouter request failed (HTTP 402): Insufficient credits' },
    }),
  })

  const ai = await findRow('AI Visibility')
  expect(within(ai).getByText(summary)).toBeTruthy()
  expect(within(ai).getByText(/Insufficient credits/)).toBeTruthy()
  expect(primaryActions().map(action => action.textContent)).toEqual(['Run check again'])
  // The panel it reopens words its review by the same baseline.
  fireEvent.click(within(ai).getByRole('button', { name: 'Run check again' }))
  expect((await screen.findByTestId('setup-panel')).getAttribute('data-has-baseline')).toBe(String(baselineRunId !== null))
})

test('a failed check says what to do engine by engine, with each engine\'s own message one step away', async () => {
  renderTracker({
    setup: setupRead({
      agentReadiness: { state: 'completed', runId: 'run-scan', result: { score: 70, pagesScored: 12 } },
      aiVisibility: {
        state: 'failed', runId: 'run-ai', blockedBy: null, engines: ['gemini', 'openrouter:vendor/model-a'],
        error: 'gemini: Unexpected token < in JSON • openrouter:vendor/model-a: OpenRouter request failed (HTTP 402): Insufficient credits',
        failedEngines: [
          { provider: 'gemini', code: 'PARSE_ERROR', message: 'Unexpected token < in JSON', skipped: false },
          { provider: 'openrouter:vendor/model-a', code: 'PROVIDER_BILLING', message: 'OpenRouter request failed (HTTP 402): Insufficient credits', skipped: false },
        ],
      },
    }),
  })

  const ai = await findRow('AI Visibility')
  expect(within(ai).getByText('The check did not finish. No baseline was saved.')).toBeTruthy()
  // The credit belongs to the OpenRouter connection, not the model routed through it.
  const remedy = within(ai).getByText('Your OpenRouter account is out of credit. Add credit at OpenRouter, then run the check again.')
  const message = remedy.parentElement!.querySelector('details')!
  expect(message.open).toBe(false)
  expect(within(message).getByText('Engine message', { selector: 'summary' })).toBeTruthy()
  expect(within(message).getByText(/: OpenRouter request failed \(HTTP 402\): Insufficient credits$/)).toBeTruthy()
  // A failure with no step of its own shows the engine's words directly.
  expect(within(ai).getByText('Gemini: Unexpected token < in JSON')).toBeTruthy()
  // The one-line error is not repeated beside them.
  expect(within(ai).queryByText(/ • /)).toBeNull()
  expect(primaryActions().map(action => action.textContent)).toEqual(['Run check again'])
})

test('a running scan stops only after a confirmation that says it keeps no score', async () => {
  let cancelled = false
  const { requests } = renderTracker({
    setup: () => jsonResponse(cancelled
      ? setupRead({ agentReadiness: { state: 'cancelled', runId: 'run-scan' } })
      : setupRead({ agentReadiness: { state: 'running', runId: 'run-scan', progress: { phase: 'checking', pagesFound: 40, pagesChecked: 10, pageLimit: 100, linksFound: 80, pagesFailed: 0 } } })),
    onRequest: (path, init) => {
      if (path !== '/api/v1/runs/run-scan/cancel' || init?.method !== 'POST') return undefined
      cancelled = true
      return jsonResponse({ id: 'run-scan', status: 'cancelled' })
    },
  })

  const ask = await within(await findRow('Agent Readiness')).findByRole('button', { name: 'Cancel scan' })
  ask.focus()
  fireEvent.click(ask)
  const confirm = within(row('Agent Readiness')).getByRole('group', { name: 'Stop the scan' })
  expect(within(confirm).getByText('Stop the scan? It saves no score.')).toBeTruthy()
  // Focus lands on Keep running, so a stray Enter keeps the scan.
  expect(document.activeElement).toBe(within(confirm).getByRole('button', { name: 'Keep running' }))
  fireEvent.click(within(confirm).getByRole('button', { name: 'Keep running' }))
  // Keeping it running puts focus back on the question.
  expect(document.activeElement).toBe(within(row('Agent Readiness')).getByRole('button', { name: 'Cancel scan' }))
  expect(requests.some(request => request.path.endsWith('/cancel'))).toBe(false)

  fireEvent.click(within(row('Agent Readiness')).getByRole('button', { name: 'Cancel scan' }))
  fireEvent.click(within(row('Agent Readiness')).getByRole('button', { name: 'Stop scan' }))
  await waitFor(() => expect(within(row('Agent Readiness')).getByText('Cancelled')).toBeTruthy())
  expect(requests.filter(request => request.method === 'POST' && request.path === '/api/v1/runs/run-scan/cancel')).toHaveLength(1)
  expect(within(row('Agent Readiness')).getByRole('button', { name: 'Run audit scan again' })).toBeTruthy()
})

test.each([
  { baselineRunId: null, note: 'Stop the check? It saves no baseline.', next: 'Review first check' },
  // Stopping a later check keeps the project's results; the next check is not its first.
  { baselineRunId: 'run-ai-1', note: 'Stop the check? Earlier results stay as they are.', next: 'Review check' },
] as const)('a running check stops through the same confirmation, which says what stopping keeps (baseline $baselineRunId)', async ({ baselineRunId, note, next }) => {
  let cancelled = false
  const { requests } = renderTracker({
    setup: () => jsonResponse(cancelled
      ? setupRead({ aiVisibility: { state: 'cancelled', runId: 'run-ai', baselineRunId, blockedBy: null, engines: ['openrouter'] } })
      : setupRead({ aiVisibility: { state: 'running', runId: 'run-ai', baselineRunId, blockedBy: null, engines: ['openrouter'], progress: { answersSaved: 2, answersPlanned: 8 } } })),
    onRequest: (path, init) => {
      if (path !== '/api/v1/runs/run-ai/cancel' || init?.method !== 'POST') return undefined
      cancelled = true
      return jsonResponse({ id: 'run-ai', status: 'cancelled' })
    },
  })

  fireEvent.click(await within(await findRow('AI Visibility')).findByRole('button', { name: 'Cancel check' }))
  expect(within(row('AI Visibility')).getByText(note)).toBeTruthy()
  fireEvent.click(within(row('AI Visibility')).getByRole('button', { name: 'Stop check' }))
  await waitFor(() => expect(within(row('AI Visibility')).getByText(/^The last check was cancelled\./)).toBeTruthy())
  expect(within(row('AI Visibility')).getByRole('button', { name: next })).toBeTruthy()
  expect(requests.filter(request => request.method === 'POST' && request.path === '/api/v1/runs/run-ai/cancel')).toHaveLength(1)
})

test('a check started elsewhere after one launched here shows its own progress and result, never stuck at Queued', async () => {
  const reads = [
    setupRead({ aiVisibility: { blockedBy: null, engines: ['openrouter'] } }),
    // The launch from the panel, before the read lists it.
    setupRead({ aiVisibility: { blockedBy: null, engines: ['openrouter'] } }),
    // A newer check, started from the CLI or an agent.
    setupRead({ aiVisibility: { state: 'running', runId: 'cli-run', blockedBy: null, engines: ['openrouter'], progress: { answersSaved: 2, answersPlanned: 5 } } }),
    setupRead({
      aiVisibility: {
        state: 'completed', runId: 'cli-run', baselineRunId: 'cli-run', blockedBy: null, engines: ['openrouter'],
        result: { first: true, answers: 5, engines: 1, queryCounts: { totalQueries: 5, citedQueries: 1, mentionedQueries: 2 }, queryCountsByClass: null },
      },
    }),
  ]
  let read = 0
  const { queryClient } = renderTracker({ setup: () => jsonResponse(reads[Math.min(read++, reads.length - 1)]!) })
  const setupKey = getApiV1ProjectsByNameSetupQueryKey({ client: heyClient, path: { name: PROJECT } })

  fireEvent.click(await within(await findRow('AI Visibility')).findByRole('button', { name: 'Review first check' }))
  fireEvent.click(await within(row('AI Visibility')).findByRole('button', { name: 'Run first check' }))
  await waitFor(() => expect(within(row('AI Visibility')).getByText('Queued')).toBeTruthy())

  await queryClient.invalidateQueries({ queryKey: setupKey })
  await waitFor(() => expect(within(row('AI Visibility')).getByText('2 of 5 answers saved')).toBeTruthy())
  expect(within(row('AI Visibility')).getByText('Running')).toBeTruthy()
  expect(within(row('AI Visibility')).getByRole('button', { name: 'Cancel check' })).toBeTruthy()

  await queryClient.invalidateQueries({ queryKey: setupKey })
  await waitFor(() => expect(within(row('AI Visibility')).getByText('Complete')).toBeTruthy())
  expect(statusLines()[1]).toBe('AI Visibility check complete. 5 answers from 1 engine.')
})

test('a scan or check that finishes here reads the runs list again, so the top bar never lags the row', async () => {
  let reads = 0
  const { queryClient } = renderTracker({
    setup: () => {
      reads += 1
      return jsonResponse(reads === 1
        ? setupRead({ agentReadiness: { state: 'running', runId: 'run-scan', progress: null } })
        : setupRead({ agentReadiness: { state: 'failed', runId: 'run-scan', error: 'Site audit root URL rejected.' } }))
    },
  })
  const runsKey = getApiV1RunsQueryKey({ client: heyClient })
  queryClient.setQueryData(runsKey, [])

  await within(await findRow('Agent Readiness')).findByText('Running')
  expect(queryClient.getQueryState(runsKey)?.isInvalidated).toBe(false)
  await queryClient.invalidateQueries({ queryKey: getApiV1ProjectsByNameSetupQueryKey({ client: heyClient, path: { name: PROJECT } }) })
  await within(row('Agent Readiness')).findByText('Failed')
  await waitFor(() => expect(queryClient.getQueryState(runsKey)?.isInvalidated).toBe(true))
})

test('closing the AI Visibility panel returns focus to the button that opened it', async () => {
  renderTracker({ setup: setupRead({ aiVisibility: { blockedBy: 'no_queries', engines: ['openrouter'] } }) })

  const open = await within(await findRow('AI Visibility')).findByRole('button', { name: 'Add queries' })
  open.focus()
  fireEvent.click(open)
  // The open panel takes the opener's place in the row.
  const back = await within(row('AI Visibility')).findByRole('button', { name: 'Back' })
  expect(within(row('AI Visibility')).queryByRole('button', { name: 'Add queries' })).toBeNull()
  back.focus()
  fireEvent.click(back)

  await waitFor(() => expect(document.activeElement).toBe(within(row('AI Visibility')).getByRole('button', { name: 'Add queries' })))
})

test('a check launched from the panel leaves focus on the AI Visibility row, which reads Queued until the server lists the check', async () => {
  renderTracker({ setup: setupRead({ aiVisibility: { blockedBy: null, engines: ['openrouter'], queries: { total: 3, nonBrand: 2, branded: 1, unclassified: 0 } } }) })

  const open = await within(await findRow('AI Visibility')).findByRole('button', { name: 'Review first check' })
  open.focus()
  fireEvent.click(open)
  const launch = await within(row('AI Visibility')).findByRole('button', { name: 'Run first check' })
  launch.focus()
  fireEvent.click(launch)

  // A queued check has no action in the row, so focus lands on the row's title.
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'AI Visibility' })))
  expect(within(row('AI Visibility')).getByText('Queued')).toBeTruthy()
  expect(within(row('AI Visibility')).getByRole('progressbar', { name: 'AI Visibility check progress' })).toBeTruthy()
  expect(statusLines()).toEqual(['', 'AI Visibility check queued.'])
  // The server does not list the check yet, so there is no run to stop.
  expect(within(row('AI Visibility')).queryByRole('button', { name: 'Cancel check' })).toBeNull()
})

test('starting the audit scan sends the first-scan cap, raises no queued toast, and reads setup again', async () => {
  let setupReads = 0
  const { requests } = renderTracker({
    setup: () => {
      setupReads += 1
      return jsonResponse(setupReads === 1
        ? setupRead()
        : setupRead({ agentReadiness: { state: 'queued', runId: 'run-scan', progress: null } }))
    },
    onRequest: (path, init) => path === `/api/v1/projects/${PROJECT}/agent-readiness/runs` && init?.method === 'POST'
      ? jsonResponse({ runId: 'run-scan', status: 'queued' })
      : undefined,
  })

  const button = await findScanStart()
  button.focus()
  fireEvent.click(button)

  await waitFor(() => expect(within(row('Agent Readiness')).getByText('Queued')).toBeTruthy())
  const start = requests.find(request => request.method === 'POST' && request.path.endsWith('/agent-readiness/runs'))
  expect(JSON.parse(String(start?.body))).toEqual({ checkDeadLinks: true, maxPages: 100 })
  expect(setupReads).toBe(2)
  expect(getToasts().some(toast => /queued/i.test(toast.title))).toBe(false)
  // Progress replaced the button that had focus, so focus stays in the row, on its title.
  expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Agent Readiness' }))
  expect(statusLines()).toEqual(['Agent Readiness audit scan queued.', ''])
})

test('a scan that cannot start says why in its row', async () => {
  renderTracker({
    setup: setupRead(),
    onRequest: (path, init) => path.endsWith('/agent-readiness/runs') && init?.method === 'POST'
      ? jsonResponse({ error: { code: 'RUN_IN_PROGRESS', message: 'A scan is already running.' } }, 409)
      : undefined,
  })
  fireEvent.click(await findScanStart())
  expect((await within(row('Agent Readiness')).findByRole('alert')).textContent).toBe('The audit scan could not start. A scan is already running.')
})

test.each([
  { blockedBy: 'no_engine', action: 'Connect an AI engine', step: 'engine' },
  { blockedBy: 'engines_failing', action: 'Repair connection', step: 'engine' },
  { blockedBy: 'no_queries', action: 'Add queries', step: 'queries' },
  { blockedBy: null, action: 'Review first check', step: 'first-check' },
] as const)('the AI Visibility action for blocker $blockedBy opens the panel at its $step step', async ({ blockedBy, action, step }) => {
  renderTracker({ setup: setupRead({ aiVisibility: { blockedBy, engines: blockedBy === 'no_engine' ? [] : ['openrouter'] } }) })
  fireEvent.click(await within(await findRow('AI Visibility')).findByRole('button', { name: action }))
  expect((await screen.findByTestId('setup-panel')).getAttribute('data-initial-step')).toBe(step)
})

test.each([
  { blockedBy: 'no_queries', step: 'queries' },
  { blockedBy: null, step: 'first-check' },
  // A plan is published on the measurement plan, so the link opens no panel.
  { blockedBy: 'plan_unpublished', step: null },
] as const)('a link to the AI Visibility row with blocker $blockedBy opens the panel at step $step', async ({ blockedBy, step }) => {
  renderTracker({ setup: setupRead({ aiVisibility: { blockedBy, engines: ['openrouter'] } }), track: 'ai-visibility' })
  await findRow('AI Visibility')
  if (step === null) {
    expect(screen.queryByTestId('setup-panel')).toBeNull()
    return
  }
  expect((await screen.findByTestId('setup-panel')).getAttribute('data-initial-step')).toBe(step)
})

test.each([
  { baselineRunId: null, line: 'Publish the measurement plan before the first check.' },
  { baselineRunId: 'run-ai-1', line: 'Publish the measurement plan before the next check.' },
] as const)('an Advanced project waiting on its published plan links to the measurement plan (baseline $baselineRunId)', async ({ baselineRunId, line }) => {
  renderTracker({ setup: setupRead({ agentReadiness: { state: 'completed', result: { score: 70, pagesScored: 12 } }, aiVisibility: { mode: 'advanced', baselineRunId, blockedBy: 'plan_unpublished' } }) })
  const ai = await findRow('AI Visibility')
  expect(within(ai).getByText(line)).toBeTruthy()
  expect(within(ai).getByRole('link', { name: 'Open measurement plan' }).getAttribute('href')).toBe('/projects/$projectName/portfolio')
})

test('an unknown project says so instead of showing an empty tracker', async () => {
  renderTracker({ setup: () => jsonResponse({ error: { code: 'NOT_FOUND', message: "Project 'canonry-ai' not found" } }, 404) })
  expect(await screen.findByText(`No project named ${PROJECT}.`)).toBeTruthy()
  expect(screen.queryByRole('list')).toBeNull()
})

/** The onboarding events the page sent, as the collector would validate them. */
function telemetry(requests: Array<{ path: string; body?: RequestInit['body'] }>) {
  return requests
    .filter(request => request.path === '/api/v1/telemetry/onboarding')
    .map(request => onboardingTelemetryEventSchema.parse(JSON.parse(String(request.body))))
}

test('a scan started here reports its start and its result on the Agent Readiness funnel', async () => {
  let reads = 0
  const { requests } = renderTracker({
    setup: () => {
      reads += 1
      return jsonResponse(reads === 1
        ? setupRead()
        : setupRead({ agentReadiness: { state: 'completed', runId: 'run-scan', result: { score: 80, pagesScored: 40 } } }))
    },
    onRequest: (path, init) => path.endsWith('/agent-readiness/runs') && init?.method === 'POST'
      ? jsonResponse({ runId: 'run-scan', status: 'queued' })
      : undefined,
  })

  fireEvent.click(await findScanStart())

  await waitFor(() => expect(telemetry(requests).some(event => event.event === 'onboarding.step_completed')).toBe(true))
  const events = telemetry(requests).map(event => `${event.surface} ${event.event} ${'step' in event ? event.step : '-'}`).sort()
  expect(events).toEqual([
    'platform run.requested -',
    'site_health onboarding.started run',
    'site_health onboarding.step_completed run',
  ])
})

test.each([
  { name: 'a check that saved answers', track: { state: 'completed' as const, answers: 4 }, expected: { event: 'onboarding.step_completed', method: 'automatic', countBucket: '4-5' } },
  { name: 'a check that saved nothing', track: { state: 'completed' as const, answers: 0 }, expected: { event: 'onboarding.blocked', action: 'retry_run', reasonCode: 'run_failed' } },
  { name: 'a failed check', track: { state: 'failed' as const, answers: null }, expected: { event: 'onboarding.blocked', action: 'retry_run', reasonCode: 'run_failed' } },
  { name: 'a cancelled check', track: { state: 'cancelled' as const, answers: null }, expected: { event: 'onboarding.blocked', action: 'retry_run', reasonCode: 'run_cancelled' } },
])('$name launched before a reload reports once on the AI Visibility funnel', async ({ track, expected }) => {
  markOnboardingRunLaunched(PROJECT, 'run-ai', RunKinds['answer-visibility'])
  const read = setupRead({
    agentReadiness: { state: 'completed', runId: 'run-scan', result: { score: 80, pagesScored: 40 } },
    aiVisibility: {
      state: track.state, runId: 'run-ai', baselineRunId: track.answers === null ? null : 'run-ai', blockedBy: null,
      result: track.answers === null ? null : { first: true, answers: track.answers, engines: 1, queryCounts: null, queryCountsByClass: null },
      error: track.state === 'failed' ? 'gemini: Quota exceeded' : null,
    },
  })
  const first = renderTracker({ setup: read })
  await waitFor(() => expect(telemetry(first.requests)).toHaveLength(1))
  expect(telemetry(first.requests)[0]).toMatchObject({ surface: 'wizard', step: 'run', ...expected })
  cleanup()

  // Reloading again reports nothing more: the outcome was recorded once.
  const second = renderTracker({ setup: read })
  await findRow('AI Visibility')
  expect(telemetry(second.requests)).toEqual([])
})
