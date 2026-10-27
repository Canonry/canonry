import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { measurementPlanResponseSchema } from '@canonry/canonry-contracts'
import {
  getApiV1ProjectsQueryKey,
  getApiV1ProjectsByNameQueryKey,
  getApiV1ProjectsByNameMeasurementPlanQueryKey,
  getApiV1ProjectsByNameMeasurementSetupQueryKey,
} from '@canonry/canonry-api-client/react-query'

import { heyClient } from '../src/api.js'
import { ThemeProvider } from '../src/contexts/theme-context.js'
import { ThemeSelector } from '../src/components/shared/ThemeSelector.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { createAppRouter } from '../src/router/router.js'
import { preloadAllLazyRoutes } from '../src/router/routes.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

const STORAGE_KEY = 'canonry:theme'
const THEME_LABELS = { light: 'Light', dark: 'Dark', system: 'System' } as const
let darkSystem = false
let media: MediaQueryList
let meta: HTMLMetaElement

beforeEach(() => {
  localStorage.clear()
  delete window.__CANONRY_CONFIG__
  delete document.documentElement.dataset.theme
  document.documentElement.style.colorScheme = ''
  meta = document.createElement('meta')
  meta.name = 'theme-color'
  document.head.append(meta)
  darkSystem = false
  const target = new EventTarget()
  media = Object.assign(target, {
    get matches() { return darkSystem },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
  }) as MediaQueryList
  Object.defineProperty(media, 'matches', { get: () => darkSystem })
  vi.stubGlobal('matchMedia', vi.fn(() => media))
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  localStorage.clear()
  delete window.__CANONRY_CONFIG__
  delete document.documentElement.dataset.theme
  document.documentElement.style.colorScheme = ''
  meta.remove()
})

function changeSystem(dark: boolean) {
  act(() => {
    darkSystem = dark
    const event = new Event('change')
    Object.defineProperty(event, 'matches', { value: dark })
    media.dispatchEvent(event)
  })
}

function expectTheme(mode: 'light' | 'dark', target: Document = document) {
  expect(target.documentElement.dataset.theme).toBe(mode)
  expect(target.documentElement.style.colorScheme).toBe(mode)
  expect(target.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(mode === 'light' ? '#ffffff' : '#0a0a0a')
}

function chooseTheme(value: 'light' | 'dark' | 'system') {
  const group = screen.getByRole('radiogroup', { name: 'Color theme' })
  fireEvent.click(within(group).getByRole('radio', { name: THEME_LABELS[value] }))
}

function expectPreference(value: 'light' | 'dark' | 'system') {
  const group = screen.getByRole('radiogroup', { name: 'Color theme' })
  const selected = within(group).getByRole('radio', { checked: true })
  expect(selected).toBe(within(group).getByRole('radio', { name: THEME_LABELS[value] }))
}

function renderSelector() {
  return render(<ThemeProvider><ThemeSelector /></ThemeProvider>)
}

test('starts dark, saves pointer and keyboard selections, and restores the choice after remounting', () => {
  const first = renderSelector()
  expectTheme('dark')
  expectPreference('dark')
  const group = screen.getByRole('radiogroup', { name: 'Color theme' })
  const radios = ['Light', 'Dark', 'System'].map(name => within(group).getByRole<HTMLButtonElement>('radio', { name }))
  expect(radios.map(radio => radio.tabIndex)).toEqual([-1, 0, -1])
  chooseTheme('light')
  expectTheme('light')
  expectPreference('light')
  expect(localStorage.getItem(STORAGE_KEY)).toBe('light')
  act(() => radios[0]!.focus())
  for (const [key, value, mode, indexes] of [
    ['ArrowRight', 'dark', 'dark', [-1, 0, -1]],
    ['End', 'system', 'light', [-1, -1, 0]],
    ['Home', 'light', 'light', [0, -1, -1]],
  ] as const) {
    fireEvent.keyDown(document.activeElement!, { key })
    expectTheme(mode)
    expectPreference(value)
    expect(document.activeElement).toBe(within(group).getByRole('radio', { name: THEME_LABELS[value] }))
    expect(radios.map(radio => radio.tabIndex)).toEqual(indexes)
    expect(localStorage.getItem(STORAGE_KEY)).toBe(value)
  }
  first.unmount()
  renderSelector()
  expectTheme('light')
  expectPreference('light')
})

test('System follows live OS changes while explicit modes keep their own selection', () => {
  localStorage.setItem(STORAGE_KEY, 'system')
  render(<StrictMode><ThemeProvider><ThemeSelector /></ThemeProvider></StrictMode>)
  expectTheme('light')
  changeSystem(true)
  expectTheme('dark')
  chooseTheme('light')
  changeSystem(false)
  changeSystem(true)
  expectTheme('light')
  chooseTheme('dark')
  changeSystem(false)
  expectTheme('dark')
  chooseTheme('system')
  expectTheme('light')
  expect(localStorage.getItem(STORAGE_KEY)).toBe('system')
})

test('synchronizes saved choices across tabs and returns to dark when the preference is removed', () => {
  renderSelector()
  const sync = (key: string | null, newValue: string | null, storageArea = localStorage) => {
    act(() => { window.dispatchEvent(new StorageEvent('storage', { key, newValue, storageArea })) })
  }
  localStorage.setItem(STORAGE_KEY, 'light')
  sync(STORAGE_KEY, 'light')
  expectTheme('light')
  expectPreference('light')
  sync('unrelated-preference', 'dark')
  sync(STORAGE_KEY, 'dark', sessionStorage)
  expectTheme('light')
  localStorage.removeItem(STORAGE_KEY)
  sync(STORAGE_KEY, null)
  expectTheme('dark')
  chooseTheme('light')
  localStorage.clear()
  sync(null, null)
  expectTheme('dark')
})

test('keeps theme selection usable when browser storage denies reads and writes', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError') })
  renderSelector()
  expectTheme('dark')
  chooseTheme('light')
  expectTheme('light')
  expectPreference('light')
})

test.each([
  { saved: null, systemDark: false, expected: 'dark' },
  { saved: 'light', systemDark: true, expected: 'light' },
  { saved: 'dark', systemDark: false, expected: 'dark' },
  { saved: 'system', systemDark: false, expected: 'light' },
  { saved: 'system', systemDark: true, expected: 'dark' },
  { saved: 'invalid', systemDark: false, expected: 'dark' },
  { saved: 'dark', systemDark: true, embed: { mode: ' light ' }, expected: 'light' },
  { saved: 'light', systemDark: false, embed: { mode: 'dark' }, expected: 'dark' },
  { saved: 'light', systemDark: false, embed: {}, expected: 'dark' },
  { saved: 'light', systemDark: false, denied: true, expected: 'dark' },
] as const)('applies the initial canvas before React: $saved, OS dark=$systemDark, embed=$embed, denied=$denied', async ({ saved, systemDark, expected, ...options }) => {
  if (saved !== null) localStorage.setItem(STORAGE_KEY, saved)
  darkSystem = systemDark
  if ('embed' in options) window.__CANONRY_CONFIG__ = { embed: { enabled: true, theme: options.embed } }
  if ('denied' in options) vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('Denied', 'SecurityError') })
  const html = await readFile(resolve(import.meta.dirname, '../index.html'), 'utf8')
  const initial = new DOMParser().parseFromString(html, 'text/html')
  const script = initial.querySelector<HTMLScriptElement>('#theme-bootstrap')!
  const root = initial.getElementById('root')!
  expect(script.compareDocumentPosition(root) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  // The real document bootstrap runs without the React tree or provider.
  root.remove()
  runInNewContext(script.textContent ?? '', { document: initial, window, localStorage })
  expectTheme(expected, initial)
  renderSelector()
  expectTheme(expected)
})

const advancedPlan = measurementPlanResponseSchema.parse({ active: {
  revision: 1,
  checksum: 'a'.repeat(64),
  createdAt: '2026-08-01T12:00:00.000Z',
  plan: {
    schemaVersion: 2,
    identities: { projectBrand: { canonicalHost: 'locations.example', ownedHosts: ['locations.example'], names: ['Locations'] } },
    targets: [{ stableKey: 'harbor', label: 'Harbor House', aliases: ['Harbor House'], urlMatchers: [{ kind: 'prefix', host: 'locations.example', pathPrefix: '/harbor', pathCase: 'insensitive' }], mentionNotApplicable: false, discoveryIdentity: 'sitemap:harbor' }],
    groups: [],
    querySnapshots: [{ queryId: 'q1', queryText: 'nearby event venues', provenance: { source: 'manual', sourceId: null, capturedAt: '2026-08-01T12:00:00.000Z' } }],
    assignments: [{ targetKey: 'harbor', queryId: 'q1', queryClass: 'non-brand', executionNodeKey: 'node1' }],
    executionNodes: [{ stableKey: 'node1', queryId: 'q1', queryText: 'nearby event venues', context: { providers: ['openai'], models: { openai: 'search-model' }, location: null }, expectedSnapshots: 1 }],
    usageEdges: [{ executionNodeKey: 'node1', targetKey: 'harbor', queryId: 'q1' }],
    compiledChecksum: 'b'.repeat(64),
  },
} })

async function renderApplication(mode: 'simple' | 'advanced', embedded = false) {
  await preloadAllLazyRoutes()
  const fixture = createDashboardFixture()
  const project = fixture.dashboard.projects[0]!.project
  const plan = mode === 'advanced' ? advancedPlan : { active: null }
  const setup = mode === 'advanced'
    ? { state: 'operational', nextAction: 'view_measurement', mode: 'active-v2', answerVisibilityProviderReady: true, activeRevision: 1, activeSchemaVersion: 2, draft: null }
    : { state: 'simple', nextAction: 'start_setup', mode: 'simple', answerVisibilityProviderReady: true, activeRevision: null, activeSchemaVersion: null, draft: null }
  window.__CANONRY_CONFIG__ = {
    dashboard: { showAgentBar: false },
    ...(embedded ? { embed: { enabled: true, theme: { mode: 'light' } } } : {}),
  }
  onTestFinished(mockFetch(url => {
    const path = pathOf(url).split('?')[0]!
    if (path.endsWith('/measurement-plan')) return jsonResponse(plan)
    if (path.endsWith('/measurement-setup')) return jsonResponse(setup)
    if (path.endsWith('/projects')) return jsonResponse(fixture.dashboard.projects.map(entry => entry.project))
    return jsonResponse({ error: { code: 'NOT_FOUND', message: 'This read is outside the theme fixture.' } }, 404)
  }))
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => queryClient.clear())
  queryClient.setQueryData(getApiV1ProjectsQueryKey({ client: heyClient }), fixture.dashboard.projects.map(entry => entry.project))
  queryClient.setQueryData(getApiV1ProjectsByNameQueryKey({ client: heyClient, path: { name: project.name } }), project)
  queryClient.setQueryData(getApiV1ProjectsByNameMeasurementPlanQueryKey({ client: heyClient, path: { name: project.name } }), plan)
  queryClient.setQueryData(getApiV1ProjectsByNameMeasurementSetupQueryKey({ client: heyClient, path: { name: project.name } }), setup)
  const path = embedded ? '/projects' : `/projects/${encodeURIComponent(project.name)}/settings`
  const router = createAppRouter(queryClient, { initialEntries: [path] })
  await router.load()
  return render(<ThemeProvider><QueryClientProvider client={queryClient}><DashboardProvider value={fixture}><RouterProvider router={router} /></DashboardProvider></QueryClientProvider></ThemeProvider>)
}

test.each(['simple', 'advanced'] as const)('mounts the saved theme control in the actual %s project shell', async mode => {
  await renderApplication(mode)
  expect(await screen.findByRole('button', { name: mode === 'advanced' ? 'Edit setup' : 'Set up advanced measurement' })).toBeTruthy()
  const toggle = screen.getByRole('radiogroup', { name: 'Color theme' })
  expect(toggle.closest('header')).not.toBeNull()
  chooseTheme('light')
  expectTheme('light')
  expect(localStorage.getItem(STORAGE_KEY)).toBe('light')
})

test('keeps embedded hosts in control of the canvas and leaves out the standalone selector', async () => {
  localStorage.setItem(STORAGE_KEY, 'dark')
  const view = await renderApplication('simple', true)
  expect(view.container.querySelector('.app-shell-embed')).not.toBeNull()
  expect(screen.queryByRole('radiogroup', { name: 'Color theme' })).toBeNull()
  expectTheme('light')
  changeSystem(true)
  act(() => { window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: 'system', storageArea: localStorage })) })
  expectTheme('light')
  expect(localStorage.getItem(STORAGE_KEY)).toBe('dark')
})
