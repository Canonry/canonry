import { afterEach, beforeAll, beforeEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { mockFetch } from './mock-fetch.js'

beforeAll(async () => {
  await preloadAllLazyRoutes()
})

const originalLocalStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')
const storedValues = new Map<string, string>()
const localStorageMock: Storage = {
  get length() {
    return storedValues.size
  },
  clear() {
    storedValues.clear()
  },
  getItem(key) {
    return storedValues.get(key) ?? null
  },
  key(index) {
    return [...storedValues.keys()][index] ?? null
  },
  removeItem(key) {
    storedValues.delete(key)
  },
  setItem(key, value) {
    storedValues.set(key, value)
  },
}

function installLocalStorage(storage: Storage) {
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: storage,
  })
}

beforeEach(() => {
  installLocalStorage(localStorageMock)
})

afterEach(() => {
  cleanup()
  storedValues.clear()
  if (originalLocalStorageDescriptor) {
    Object.defineProperty(window, 'localStorage', originalLocalStorageDescriptor)
  } else {
    Reflect.deleteProperty(window, 'localStorage')
  }
})

async function renderRoute(pathname: string, options: Parameters<typeof createDashboardFixture>[0] = {}) {
  const fixture = createDashboardFixture(options)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: [pathname] })
  await router.load()

  const renderFixture = (nextFixture: ReturnType<typeof createDashboardFixture>) => (
    <QueryClientProvider client={queryClient}>
      <DashboardProvider value={{ dashboard: nextFixture.dashboard, health: nextFixture.health }}>
        <RouterProvider router={router} />
      </DashboardProvider>
    </QueryClientProvider>
  )
  const rendered = render(renderFixture(fixture))

  return {
    ...rendered,
    router,
    rerenderDashboard(nextOptions: Parameters<typeof createDashboardFixture>[0] = {}) {
      rendered.rerender(renderFixture(createDashboardFixture(nextOptions)))
    },
  }
}

async function renderColdSetupRoute() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const router = createAppRouter(queryClient, { initialEntries: ['/setup'] })
  await router.load()

  const restoreFetch = mockFetch(() => new Promise<Response>(() => {}))
  onTestFinished(restoreFetch)

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  )
}

test('sidebar can be hidden and restored from the desktop topbar', async () => {
  const { container, getByRole } = await renderRoute('/projects/project_citypoint/report')

  expect(container.querySelector('#desktop-sidebar')).not.toBeNull()
  expect(getByRole('button', { name: 'Hide sidebar' }).getAttribute('aria-controls')).toBe('desktop-sidebar')

  fireEvent.click(getByRole('button', { name: 'Hide sidebar' }))

  expect(container.querySelector('#desktop-sidebar')).toBeNull()
  expect(container.querySelector('.app-shell-sidebar-hidden')).not.toBeNull()
  expect(window.localStorage.getItem('canonry:sidebarHidden')).toBe('true')
  expect(getByRole('button', { name: 'Show sidebar' }).getAttribute('aria-controls')).toBeNull()

  fireEvent.click(getByRole('button', { name: 'Show sidebar' }))

  expect(container.querySelector('#desktop-sidebar')).not.toBeNull()
  expect(container.querySelector('.app-shell-sidebar-hidden')).toBeNull()
  expect(window.localStorage.getItem('canonry:sidebarHidden')).toBeNull()
  expect(getByRole('button', { name: 'Hide sidebar' }).getAttribute('aria-controls')).toBe('desktop-sidebar')
})

test('navigation contains keyboard focus and restores the trigger after Escape, Close, and navigation', async () => {
  const { getByRole, findByRole, queryByRole, router } = await renderRoute('/projects')
  const trigger = getByRole('button', { name: 'Open navigation' })
  const background = getByRole('button', { name: 'Hide sidebar' })
  trigger.focus()
  fireEvent.click(trigger)

  const close = await findByRole('button', { name: 'Close navigation' })
  expect(document.activeElement).toBe(close)
  const navigation = await findByRole('dialog', { name: 'Navigation' })
  const links = within(navigation).getAllByRole('link')
  const lastLink = links.at(-1)!
  expect(queryByRole('main')).toBeNull()

  background.focus()
  expect(document.activeElement).toBe(close)
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(lastLink)
  fireEvent.keyDown(lastLink, { key: 'Tab' })
  expect(document.activeElement).toBe(close)

  fireEvent.keyDown(close, { key: 'Escape' })
  await waitFor(() => expect(queryByRole('dialog', { name: 'Navigation' })).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(trigger))
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(getByRole('main')).toBeDefined()

  fireEvent.click(trigger)
  fireEvent.click(await findByRole('button', { name: 'Close navigation' }))
  await waitFor(() => expect(document.activeElement).toBe(trigger))
  expect(queryByRole('dialog', { name: 'Navigation' })).toBeNull()

  fireEvent.click(trigger)
  const reopened = await findByRole('dialog', { name: 'Navigation' })
  fireEvent.click(within(reopened).getByRole('link', { name: 'All projects', exact: true }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/'))
  await waitFor(() => expect(queryByRole('dialog', { name: 'Navigation' })).toBeNull())
  await waitFor(() => expect(document.activeElement).toBe(trigger))
})

test('hidden sidebar preference survives a reload', async () => {
  window.localStorage.setItem('canonry:sidebarHidden', 'true')

  const { container, getByRole } = await renderRoute('/projects/project_citypoint/report')

  expect(container.querySelector('#desktop-sidebar')).toBeNull()
  expect(container.querySelector('.app-shell-sidebar-hidden')).not.toBeNull()
  expect(getByRole('button', { name: 'Show sidebar' })).toBeDefined()
})

test('navigation Escape does not also dismiss an underlying run drawer', async () => {
  const runId = 'run_citypoint_visibility_20260308'
  const { getByRole, findByRole, queryByRole, router } = await renderRoute('/')
  const trigger = getByRole('button', { name: 'Open navigation' })
  await router.navigate({ to: '/', search: (previous) => ({ ...previous, runId }) })
  await findByRole('dialog')
  // Exercise stacked dismissal while the route retains its open run.
  fireEvent.click(trigger)
  const navigation = await findByRole('dialog', { name: 'Navigation' })

  fireEvent.keyDown(within(navigation).getByRole('button', { name: 'Close navigation' }), { key: 'Escape' })
  await waitFor(() => expect(queryByRole('dialog', { name: 'Navigation' })).toBeNull())
  expect(router.state.location.search.runId).toBe(runId)
  expect(getByRole('dialog')).toBeDefined()

  fireEvent.keyDown(getByRole('dialog'), { key: 'Escape' })
  await waitFor(() => expect(router.state.location.search.runId).toBeUndefined())
})

test('falls back to a visible sidebar when stored preference cannot be read', async () => {
  installLocalStorage({
    ...localStorageMock,
    getItem() {
      throw new Error('storage unavailable')
    },
  })

  const { container, getByRole } = await renderRoute('/projects/project_citypoint/report')

  expect(container.querySelector('#desktop-sidebar')).not.toBeNull()
  expect(getByRole('button', { name: 'Hide sidebar' })).toBeDefined()
})

test('still hides the sidebar when the preference cannot be written', async () => {
  installLocalStorage({
    ...localStorageMock,
    setItem() {
      throw new Error('storage unavailable')
    },
  })

  const { container, getByRole } = await renderRoute('/projects/project_citypoint/report')

  fireEvent.click(getByRole('button', { name: 'Hide sidebar' }))

  expect(container.querySelector('#desktop-sidebar')).toBeNull()
  expect(container.querySelector('.app-shell-sidebar-hidden')).not.toBeNull()
  expect(getByRole('button', { name: 'Show sidebar' }).getAttribute('aria-controls')).toBeNull()
})

test('does not render the sidebar toggle during first-run setup', async () => {
  const { container, queryByRole } = await renderRoute('/setup', { emptyPortfolio: true })

  expect(container.querySelector('#desktop-sidebar')).toBeNull()
  expect(queryByRole('button', { name: /sidebar/i })).toBeNull()
  expect(queryByRole('button', { name: 'Open navigation' })).toBeNull()
  expect(container.querySelector('#mobile-nav')).toBeNull()
})

test('does not flash operator navigation while a cold setup load resolves readiness', async () => {
  const { container, queryByRole } = await renderColdSetupRoute()

  expect(container.querySelector('.app-shell-focus')).not.toBeNull()
  expect(container.querySelector('#desktop-sidebar')).toBeNull()
  expect(container.querySelector('#mobile-nav')).toBeNull()
  expect(queryByRole('button', { name: 'Open navigation' })).toBeNull()
})

test('keeps the first-run shell focused after onboarding creates a project', async () => {
  const { container, queryByRole, rerenderDashboard } = await renderRoute('/setup', { emptyPortfolio: true })

  rerenderDashboard()

  expect(container.querySelector('#desktop-sidebar')).toBeNull()
  expect(queryByRole('button', { name: /sidebar/i })).toBeNull()
  expect(container.querySelector('.app-shell-focus')).not.toBeNull()
})

test('keeps a reloaded Site Health results handoff focused after project creation', async () => {
  const { container, queryByRole } = await renderRoute(
    '/setup?onboarding=site-health&setupProject=project_citypoint&siteHealthRunId=run_site_health',
  )

  expect(container.querySelector('.app-shell-focus')).not.toBeNull()
  expect(container.querySelector('#desktop-sidebar')).toBeNull()
  expect(container.querySelector('#mobile-nav')).toBeNull()
  expect(queryByRole('button', { name: 'Open navigation' })).toBeNull()
})

test('keeps the focused AI Visibility handoff focused after project creation', async () => {
  const { container, queryByRole } = await renderRoute(
    '/setup?experience=legacy&onboarding=site-health&setupProject=project_citypoint',
  )

  expect(container.querySelector('.app-shell-focus')).not.toBeNull()
  expect(container.querySelector('#desktop-sidebar')).toBeNull()
  expect(container.querySelector('#mobile-nav')).toBeNull()
  expect(queryByRole('button', { name: 'Open navigation' })).toBeNull()
})

test('keeps a reloaded no-scan first-run handoff focused after project creation', async () => {
  const { container, queryByRole } = await renderRoute(
    '/setup?experience=legacy&onboarding=first-run&setupProject=project_citypoint',
  )

  expect(container.querySelector('.app-shell-focus')).not.toBeNull()
  expect(container.querySelector('#desktop-sidebar')).toBeNull()
  expect(container.querySelector('#mobile-nav')).toBeNull()
  expect(queryByRole('button', { name: 'Open navigation' })).toBeNull()
})

test('keeps navigation available when an existing operator opens setup', async () => {
  const { container, getByRole } = await renderRoute('/setup')

  expect(container.querySelector('#desktop-sidebar')).not.toBeNull()
  expect(getByRole('button', { name: 'Hide sidebar' })).toBeDefined()
  expect(getByRole('button', { name: 'Open navigation' })).toBeDefined()
  expect(getByRole('button', { name: 'Open navigation' }).getAttribute('aria-expanded')).toBe('false')
  expect(container.querySelector('.app-shell-focus')).toBeNull()
})

test('keeps navigation available for ordinary project-scoped setup', async () => {
  const { container, getByRole } = await renderRoute(
    '/setup?experience=legacy&setupProject=project_citypoint',
  )

  expect(container.querySelector('#desktop-sidebar')).not.toBeNull()
  expect(getByRole('button', { name: 'Hide sidebar' })).toBeDefined()
  expect(getByRole('button', { name: 'Open navigation' })).toBeDefined()
  expect(getByRole('button', { name: 'Open navigation' }).getAttribute('aria-expanded')).toBe('false')
  expect(container.querySelector('.app-shell-focus')).toBeNull()
})

test('resets first-run focus after leaving setup', async () => {
  const { container, getByRole, router, rerenderDashboard } = await renderRoute('/setup', { emptyPortfolio: true })
  rerenderDashboard()

  await router.navigate({ to: '/projects' })
  await waitFor(() => expect(container.querySelector('#desktop-sidebar')).not.toBeNull())

  await router.navigate({ to: '/setup' })
  await waitFor(() => expect(getByRole('button', { name: 'Hide sidebar' })).toBeDefined())
  expect(container.querySelector('.app-shell-focus')).toBeNull()
})

test('keeps the onboarding finish step focused, including on a reload', async () => {
  const { container, queryByRole } = await renderRoute(
    '/setup?onboarding=complete&setupProject=project_citypoint',
  )

  expect(container.querySelector('.app-shell-focus')).not.toBeNull()
  expect(container.querySelector('#desktop-sidebar')).toBeNull()
  expect(container.querySelector('#mobile-nav')).toBeNull()
  expect(queryByRole('button', { name: 'Open navigation' })).toBeNull()
})
