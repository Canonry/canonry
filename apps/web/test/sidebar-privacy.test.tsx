import { afterEach, beforeAll, beforeEach, expect, onTestFinished, test } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
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

test('hidden sidebar preference survives a reload', async () => {
  window.localStorage.setItem('canonry:sidebarHidden', 'true')

  const { container, getByRole } = await renderRoute('/projects/project_citypoint/report')

  expect(container.querySelector('#desktop-sidebar')).toBeNull()
  expect(container.querySelector('.app-shell-sidebar-hidden')).not.toBeNull()
  expect(getByRole('button', { name: 'Show sidebar' })).toBeDefined()
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
  expect(container.querySelector('#mobile-nav')).not.toBeNull()
  expect(container.querySelector('.app-shell-focus')).toBeNull()
})

test('keeps navigation available for ordinary project-scoped setup', async () => {
  const { container, getByRole } = await renderRoute(
    '/setup?experience=legacy&setupProject=project_citypoint',
  )

  expect(container.querySelector('#desktop-sidebar')).not.toBeNull()
  expect(getByRole('button', { name: 'Hide sidebar' })).toBeDefined()
  expect(getByRole('button', { name: 'Open navigation' })).toBeDefined()
  expect(container.querySelector('#mobile-nav')).not.toBeNull()
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
