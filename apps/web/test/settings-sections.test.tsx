import React from 'react'
import { afterEach, expect, test } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'

import { SettingsPage, SETTINGS_SECTION_COPY, SETTINGS_SECTION_TEST_IDS } from '../src/pages/SettingsPage.js'
import { GoogleSignInSettingsSection, GOOGLE_SIGN_IN_COPY, GOOGLE_SIGN_IN_TEST_IDS } from '../src/components/settings/GoogleSignInSettingsSection.js'
import { PEOPLE_ACCESS_TEST_IDS } from '../src/components/settings/PeopleAccessSection.js'
import { DashboardProvider } from '../src/contexts/dashboard-context.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'

const SETTINGS_PATH = '/api/v1/settings/auth/google'
const PEOPLE_PATH = '/api/v1/users'

const pendingInvitation = {
  id: 'invite_pending', email: 'pending@example.test', role: 'viewer', status: 'pending',
  createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-08T00:00:00.000Z', acceptedAt: null,
}

function googleSettings(overrides: Partial<{ enabled: boolean; configured: boolean; clientId: string | null; hasClientSecret: boolean; callbackUrl: string | null; environmentOverride: boolean; editable: boolean }> = {}) {
  return {
    enabled: false,
    configured: false,
    clientId: null,
    hasClientSecret: false,
    callbackUrl: 'https://canonry.example.test/api/v1/auth/google/callback',
    environmentOverride: false,
    editable: true,
    ...overrides,
  }
}

function renderSignIn() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}><GoogleSignInSettingsSection /></QueryClientProvider>)
}

async function renderSettings(initialEntry: string) {
  const fixture = createDashboardFixture()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const root = createRootRoute({ validateSearch: search => search, component: SettingsPage })
  const settings = createRoute({ getParentRoute: () => root, path: '/settings' })
  const router = createRouter({ routeTree: root.addChildren([settings]), history: createMemoryHistory({ initialEntries: [initialEntry] }) })
  await router.load()
  const result = render(<QueryClientProvider client={client}><DashboardProvider value={{ dashboard: fixture.dashboard, health: fixture.health }}><RouterProvider router={router} /></DashboardProvider></QueryClientProvider>)
  return { ...result, router }
}

afterEach(() => cleanup())

test('section navigation isolates people and sign-in while retaining pending invitations', async () => {
  const restore = mockFetch(url => {
    const path = String(url)
    if (path.includes(`${PEOPLE_PATH}/invitations`)) return jsonResponse({ invitations: [pendingInvitation] })
    if (path.includes(PEOPLE_PATH)) return jsonResponse({ users: [] })
    if (path.includes(SETTINGS_PATH)) return jsonResponse(googleSettings())
    return jsonResponse({})
  })
  try {
    const { router } = await renderSettings('/settings?section=people')
    expect(await screen.findByTestId(PEOPLE_ACCESS_TEST_IDS.section)).toBeTruthy()
    expect((await screen.findByTestId(PEOPLE_ACCESS_TEST_IDS.invitationsTable)).textContent).toContain(pendingInvitation.email)
    expect(screen.queryByTestId(GOOGLE_SIGN_IN_TEST_IDS.section)).toBeNull()

    await act(async () => { fireEvent.click(screen.getByTestId(SETTINGS_SECTION_TEST_IDS.signIn)) })
    expect(await screen.findByTestId(GOOGLE_SIGN_IN_TEST_IDS.section)).toBeTruthy()
    expect(screen.queryByTestId(PEOPLE_ACCESS_TEST_IDS.section)).toBeNull()
    expect(router.state.location.search.section).toBe('sign-in')
    expect(screen.getByRole('navigation', { name: SETTINGS_SECTION_COPY.navigationLabel })).toBeTruthy()

    await act(async () => { fireEvent.click(screen.getByTestId(SETTINGS_SECTION_TEST_IDS.people)) })
    expect((await screen.findByTestId(PEOPLE_ACCESS_TEST_IDS.invitationsTable)).textContent).toContain(pendingInvitation.email)
  } finally {
    restore()
  }
})

test('save and enable sends credentials in one Google settings update', async () => {
  const requests: Array<Record<string, unknown>> = []
  let current = googleSettings()
  const restore = mockFetch((url, init) => {
    if (!String(url).includes(SETTINGS_PATH)) return jsonResponse({})
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      requests.push(body)
      current = googleSettings({ enabled: true, configured: true, clientId: String(body.clientId), hasClientSecret: true })
      return jsonResponse(current)
    }
    return jsonResponse(current)
  })
  try {
    renderSignIn()
    await screen.findByTestId(GOOGLE_SIGN_IN_TEST_IDS.editor)
    fireEvent.change(screen.getByLabelText(GOOGLE_SIGN_IN_COPY.clientIdLabel), { target: { value: 'client-id' } })
    fireEvent.change(screen.getByLabelText(GOOGLE_SIGN_IN_COPY.clientSecretLabel), { target: { value: 'client-secret' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: GOOGLE_SIGN_IN_COPY.saveAndEnable })) })
    await waitFor(() => expect(requests).toEqual([{ enabled: true, clientId: 'client-id', clientSecret: 'client-secret' }]))
    await waitFor(() => expect(screen.getByTestId(GOOGLE_SIGN_IN_TEST_IDS.status).textContent).toBe(GOOGLE_SIGN_IN_COPY.enabled))
    expect(screen.getByTestId(GOOGLE_SIGN_IN_TEST_IDS.ownerLinkInstruction).textContent).toBe(GOOGLE_SIGN_IN_COPY.ownerLinkInstruction)
  } finally {
    restore()
  }
})

test.each([
  { configured: false, action: GOOGLE_SIGN_IN_COPY.saveAndEnable },
  { configured: true, action: GOOGLE_SIGN_IN_COPY.enable },
])('missing callback explains public URL recovery and disables $action', async ({ configured, action }) => {
  const settings = googleSettings({
    callbackUrl: null,
    configured,
    clientId: configured ? 'stored-client' : null,
    hasClientSecret: configured,
  })
  const restore = mockFetch(url => String(url).includes(SETTINGS_PATH) ? jsonResponse(settings) : jsonResponse({}))
  try {
    renderSignIn()
    expect((await screen.findByTestId(GOOGLE_SIGN_IN_TEST_IDS.callbackUnavailable)).textContent).toContain(GOOGLE_SIGN_IN_COPY.callbackUnavailable)
    expect(screen.getByRole('link', { name: GOOGLE_SIGN_IN_COPY.setupGuide })).toBeTruthy()

    if (!configured) {
      fireEvent.change(screen.getByLabelText(GOOGLE_SIGN_IN_COPY.clientIdLabel), { target: { value: 'client-id' } })
      fireEvent.change(screen.getByLabelText(GOOGLE_SIGN_IN_COPY.clientSecretLabel), { target: { value: 'client-secret' } })
    }
    expect((screen.getByRole('button', { name: action }) as HTMLButtonElement).disabled).toBe(true)
    expect(document.querySelector('a[href="https://console.cloud.google.com/apis/credentials"]')).toBeNull()
  } finally {
    restore()
  }
})

test('a failed sign-in save keeps entered credentials available for correction', async () => {
  const restore = mockFetch((url, init) => {
    if (!String(url).includes(SETTINGS_PATH)) return jsonResponse({})
    if (init?.method === 'PUT') return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: 'Credential save failed' } }, 400)
    return jsonResponse(googleSettings())
  })
  try {
    renderSignIn()
    await screen.findByTestId(GOOGLE_SIGN_IN_TEST_IDS.editor)
    const clientId = screen.getByLabelText(GOOGLE_SIGN_IN_COPY.clientIdLabel) as HTMLInputElement
    const clientSecret = screen.getByLabelText(GOOGLE_SIGN_IN_COPY.clientSecretLabel) as HTMLInputElement
    fireEvent.change(clientId, { target: { value: 'client-id' } })
    fireEvent.change(clientSecret, { target: { value: 'client-secret' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: GOOGLE_SIGN_IN_COPY.saveAndEnable })) })
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(clientId.value).toBe('client-id')
    expect(clientSecret.value).toBe('client-secret')
  } finally {
    restore()
  }
})

test('environment-managed Google credentials are status-only and never expose a secret editor', async () => {
  const managed = googleSettings({ enabled: true, configured: true, clientId: 'environment-client', hasClientSecret: true, environmentOverride: true, editable: false })
  const restore = mockFetch(url => String(url).includes(SETTINGS_PATH) ? jsonResponse(managed) : jsonResponse({}))
  try {
    renderSignIn()
    expect((await screen.findByTestId(GOOGLE_SIGN_IN_TEST_IDS.status)).textContent).toBe(GOOGLE_SIGN_IN_COPY.enabled)
    expect(screen.getByDisplayValue(managed.clientId!).hasAttribute('readonly')).toBe(true)
    expect(screen.queryByTestId(GOOGLE_SIGN_IN_TEST_IDS.editor)).toBeNull()
    expect(screen.queryByRole('button', { name: GOOGLE_SIGN_IN_COPY.disable })).toBeNull()
  } finally {
    restore()
  }
})
