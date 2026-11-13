import { afterEach, expect, onTestFinished, test, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import { AccountProvider, type ApiKeyAccess } from '../src/contexts/account-context.js'
import { AiVisibilitySetupPanel } from '../src/components/setup/AiVisibilitySetupPanel.js'
import { PROVIDER_CONNECTION_TEST_COPY } from '../src/components/settings/ProviderConnectionTest.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'
import { connectionFixture, settingsFixture } from './provider-settings-fixtures.js'

vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>()
  return {
    ...actual,
    useNavigate: () => vi.fn(),
    Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  }
})

afterEach(() => {
  cleanup()
  window.sessionStorage.clear()
})

const project = { ...createDashboardFixture().dashboard.projects[0]!.project, name: 'panel-project', providers: ['gemini'] }

/**
 * The setup tracker's AI Visibility panel as production renders it: no
 * injected dashboard, so the panel makes its own reads.
 */
function renderPanel(apiKey?: ApiKeyAccess) {
  const requests: string[] = []
  const restore = mockFetch((url) => {
    const path = pathOf(url)
    requests.push(path)
    if (path === '/api/v1/projects') return jsonResponse([project])
    if (path === '/api/v1/settings') return jsonResponse(settingsFixture([connectionFixture({ name: 'gemini', displayName: 'Gemini' })]))
    if (path === `/api/v1/projects/${project.name}/measurement-setup`) return jsonResponse({ answerVisibilityProviderReady: true })
    if (path === `/api/v1/projects/${project.name}/queries`) return jsonResponse([{ id: 'query-1', query: 'best local dentist' }])
    if (path === '/health') return jsonResponse({ version: 'test', databaseUrlConfigured: true })
    return jsonResponse({ error: { code: 'NOT_FOUND', message: 'Not found' } }, 404)
  })
  onTestFinished(restore)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  onTestFinished(() => { queryClient.clear() })
  render(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={null} apiKey={apiKey}>
        <AiVisibilitySetupPanel projectName={project.name} initialStep="engine" onClose={vi.fn()} onLaunched={vi.fn()} />
      </AccountProvider>
    </QueryClientProvider>,
  )
  return { requests }
}

/** The dashboard read the panel must not make: each project's overview and the run lists. */
function dashboardReads(requests: readonly string[]): string[] {
  return requests.filter(path => path.endsWith('/overview') || path.split('?')[0] === '/api/v1/runs')
}

test('an administrator\'s panel lists the engines from the settings read, without the dashboard read', async () => {
  const { requests } = renderPanel()

  const engines = await screen.findByRole('region', { name: 'AI engines' })
  expect(within(within(engines).getByRole('list', { name: 'Saved AI engines' })).getAllByRole('listitem').map(item => item.textContent)).toEqual(['Gemini'])
  expect(within(engines).getByText(PROVIDER_CONNECTION_TEST_COPY.savedNotVerified)).toBeTruthy()
  expect(requests).toEqual(expect.arrayContaining(['/api/v1/projects', '/api/v1/settings']))
  expect(dashboardReads(requests)).toEqual([])
})

test('a project-scoped writer\'s panel reads its project\'s engine readiness, never the instance settings', async () => {
  const { requests } = renderPanel({ id: 'scoped-writer', scopes: ['*'], projectId: project.id, readOnly: false })

  const engines = await screen.findByRole('region', { name: 'AI engines' })
  expect(await within(engines).findByText(PROVIDER_CONNECTION_TEST_COPY.savedNotVerified)).toBeTruthy()
  expect(requests).toContain(`/api/v1/projects/${project.name}/measurement-setup`)
  // Instance settings carry provider credentials; the server refuses them to this key.
  expect(requests).not.toContain('/api/v1/settings')
  expect(dashboardReads(requests)).toEqual([])
})
