import React from 'react'
import { afterEach, expect, onTestFinished, test } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createBrowserHistory, createRootRoute, createRoute, createRouter, RouterProvider, useSearch } from '@tanstack/react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { queryTrackingPreviewResponseSchema } from '@canonry/canonry-contracts'
import { QueriesSection } from '../src/components/project/DiscoverySection.js'
import { AddLocationQueryButton } from '../src/components/project/queries/AddQueriesEntry.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { parseVisibilitySelection } from '../src/lib/measurement-view-url.js'
import { parseTrackedFilters } from '../src/components/project/queries/advanced/tracked-filters.js'
import { projectAddQueriesRoute, rootRoute } from '../src/router/routes.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'
import { active, chooseContext, preview, results, workspace, workspaceVersion } from './support/query-tracking-fixtures.js'

afterEach(() => { cleanup(); delete window.__CANONRY_CONFIG__ })

const LOCATION = '/projects/demo/properties/acme'
const LIST = '/projects/demo/queries'
const ADD = `${LIST}/add`
const portfolio = {
  ...workspace(),
  scopeOptions: [
    { id: 'project', label: 'Project', kind: 'project', targetCount: 1 },
    { id: 'new-york', label: 'New York', kind: 'market', targetCount: 1 },
    { id: 'acme', label: 'Acme', kind: 'property', targetCount: 1 },
  ],
}

/**
 * Actual sibling route mounts and browser history, including its popstate blocker path.
 * Memory history only applies blockers to push/replace and cannot test browser Back.
 */
function mount(entries: string[], role: 'admin' | 'viewer' = 'admin') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  function Workspace({ adding = false }: { adding?: boolean }) {
    const search = useSearch({ strict: false })
    return <QueriesSection projectName="demo" addQueriesPage={adding} selection={parseVisibilitySelection(search)} trackedFilters={parseTrackedFilters(search)} />
  }
  const root = createRootRoute({ validateSearch: rootRoute.options.validateSearch })
  const list = createRoute({ getParentRoute: () => root, path: '/projects/$projectName/queries', component: () => <Workspace /> })
  const add = createRoute({ getParentRoute: () => root, path: `/projects/$projectName${projectAddQueriesRoute.options.path}`, component: () => <Workspace adding /> })
  const location = createRoute({ getParentRoute: () => root, path: '/projects/$projectName/properties/$targetKey', component: () => <><h1>Location page</h1><AddLocationQueryButton projectName="demo" locationKey="acme" /></> })
  window.history.replaceState(null, '', entries[0]!)
  const history = createBrowserHistory()
  for (const entry of entries.slice(1)) { history.push(entry); history.flush() }
  const router = createRouter({ routeTree: root.addChildren([list, add, location]), history })
  onTestFinished(() => { history.destroy(); window.history.replaceState(null, '', '/') })
  const view = render(<AccountProvider account={{ name: role, role }}><QueryClientProvider client={queryClient}><RouterProvider router={router} /></QueryClientProvider></AccountProvider>)
  return { router, ...view }
}

async function browserBack(router: ReturnType<typeof mount>['router']) {
  await act(async () => {
    const popped = new Promise<void>(resolve => window.addEventListener('popstate', () => resolve(), { once: true }))
    router.history.back()
    await popped
  })
}

/** Transport replies are fixtures; assertions below cover navigation, never duplicate the API's classification rules. */
function installApi(commit?: () => Promise<Response>) {
  const writes: string[] = []
  onTestFinished(mockFetch((url, init) => {
    const path = new URL(url).pathname
    if (path.endsWith('/query-tracking')) return jsonResponse(portfolio)
    if (path.endsWith('/query-tracking/results')) return jsonResponse(results())
    if (path.endsWith('/measurement-query-templates')) return jsonResponse({ templates: [] })
    if (path.endsWith('/preview')) {
      writes.push('preview')
      const text = (JSON.parse(String(init?.body)) as { additions: { input: { text: string } }[] }).additions[0]!.input.text
      const row = { ...portfolio.tracked[0]!, queryId: 'query-new', queryText: text, normalizedText: text.toLowerCase(), focus: { kind: 'property', key: 'acme' } }
      return jsonResponse(queryTrackingPreviewResponseSchema.parse(preview({
        tracked: [...portfolio.tracked, row],
        diff: { added: [{ queryId: row.queryId, queryText: text, assignmentCount: 1 }], removed: [], reused: [], unchanged: [], noOp: false },
        changes: [{ queryId: row.queryId, queryText: text, change: 'added', before: { targetKeys: [], marketKeys: [] }, after: { targetKeys: ['acme'], marketKeys: ['new-york'] } }],
      })))
    }
    if (path.endsWith('/commit')) { writes.push('commit'); return commit?.() ?? jsonResponse({ committed: true, mode: 'advanced', workspaceVersion, active, reviewedAt: '2026-09-04T12:15:00.000Z' }) }
    throw new Error(`Unexpected route test request ${path}`)
  }))
  return writes
}

test('opens a page with inherited market and URL filters, and guards browser Back and confirmed Cancel exactly once', async () => {
  installApi()
  const filtered = `${LIST}?measurementScope=market&measurementScopeKey=new-york&trackedType=branded&trackedStatus=all`
  const { router } = mount([filtered])
  fireEvent.click(await screen.findByRole('button', { name: 'Add market query' }))
  await screen.findByRole('region', { name: 'Add queries' })
  expect(router.state.location.pathname).toBe(ADD)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('table', { name: 'Queries' })).toBeNull()
  expect(screen.getByText('New York · Market')).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: 'Queries' }), { target: { value: 'apartments with a garden' } })
  const unload = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(unload)
  expect(unload.defaultPrevented).toBe(true)
  await browserBack(router)
  fireEvent.click(await screen.findByRole('button', { name: 'Keep editing' }))
  await waitFor(() => expect(window.location.pathname).toBe(ADD))
  expect(router.state.location.pathname).toBe(ADD)
  expect((screen.getByRole('textbox', { name: 'Queries' }) as HTMLTextAreaElement).value).toBe('apartments with a garden')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
  await waitFor(() => expect(router.state.location.pathname).toBe(LIST))
  expect(router.state.location.search).toMatchObject({ measurementScope: 'market', measurementScopeKey: 'new-york', trackedType: 'branded', trackedStatus: 'all' })
  expect(router.state.location.search.addMarket).toBeUndefined()
  expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
})

test.each(['direct', 'more ways'] as const)('a cold location URL restores defaults and %s publication blocks exit then returns to the location', async mode => {
  let finish!: (response: Response) => void
  const pending = new Promise<Response>(resolve => { finish = resolve })
  const writes = installApi(() => pending)
  const { router } = mount([LOCATION, `${ADD}?addLocation=acme&returnLocation=acme&trackedType=branded`])
  await screen.findByRole('region', { name: 'Add queries' })
  expect(screen.getByRole('radio', { name: 'Location' }).getAttribute('aria-checked')).toBe('true')
  expect(screen.getByText('Acme · Location')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Back to location' })).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox', { name: 'Queries' }), { target: { value: 'Acme gardens' } })
  if (mode === 'more ways') {
    fireEvent.click(screen.getByRole('button', { name: 'More ways to add' }))
    await screen.findByRole('heading', { name: 'Add query' })
    // The carried first line remains unsaved work even though this editor mounted with it populated.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }))
    chooseContext()
  }
  fireEvent.click(screen.getByRole('button', { name: 'Review' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Publish 1 change' }))
  await waitFor(() => expect(writes).toEqual(['preview', 'commit']))
  await browserBack(router)
  // Wait for the actual popstate and its blocked rollback, not just the click.
  await waitFor(() => expect(window.location.pathname).toBe(ADD))
  expect(router.state.location.pathname).toBe(ADD)
  expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()
  await act(async () => { finish(jsonResponse({ committed: true, mode: 'advanced', workspaceVersion, active, reviewedAt: '2026-09-04T12:15:00.000Z' })); await pending })
  await screen.findByRole('heading', { name: 'Location page' })
  expect(router.state.location.pathname).toBe(LOCATION)
  expect(router.state.location.search.trackedType).toBe('branded')
  expect(router.state.location.search.returnLocation).toBeUndefined()
})

test('a viewer cannot reach an editable form through the direct add URL', async () => {
  const writes = installApi()
  mount([`${ADD}?addLocation=acme`], 'viewer')
  await screen.findByText('View only')
  expect(screen.queryByRole('textbox', { name: 'Queries' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Review' })).toBeNull()
  expect(writes).toEqual([])
})
