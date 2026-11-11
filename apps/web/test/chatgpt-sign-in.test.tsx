/**
 * Sign in with ChatGPT in the dashboard.
 *
 * The sign-in screen leads with "Continue with ChatGPT" when the install
 * offers it, and keeps name and password behind a disclosure for
 * administrators. A viewer whose Aero runs on their own ChatGPT plan sees whose
 * plan answers, can change model or disconnect, and is asked to connect when
 * the install requires a plan. Nothing changes for anyone else.
 */
import { afterEach, describe, expect, onTestFinished, test, vi } from 'vitest'
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import {
  getApiV1AuthChatgptModelsQueryKey,
  getApiV1AuthChatgptStatusQueryKey,
  getApiV1ProjectsByNameAgentProvidersQueryKey,
  getApiV1ProjectsQueryKey,
} from '@canonry/canonry-api-client/react-query'
import { CHATGPT_AERO_ERRORS } from '@canonry/canonry-contracts'

import { heyClient } from '../src/api.js'
import * as aero from '../src/api-aero.js'
import { AuthGate } from '../src/components/auth/AuthGate.js'
import { AeroBarHost } from '../src/components/shared/AeroBar.js'
import { parseChatGptTurnError } from '../src/components/shared/ChatGptPlan.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { resetChatGptReturnForTests } from '../src/lib/chatgpt-return.js'
import { createDashboardFixture } from '../src/mock-data.js'
import { mockFetch as installMockFetch, jsonResponse } from './mock-fetch.js'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  resetChatGptReturnForTests()
  window.history.replaceState(null, '', '/')
  delete window.__CANONRY_CONFIG__
})

function serveSession(session: Record<string, unknown>) {
  const restore = installMockFetch((url) => {
    const urlStr = String(url)
    if (urlStr.includes('/api/v1/auth/session')) return jsonResponse(session)
    if (urlStr.includes('/api/v1/session')) return jsonResponse({ authenticated: false, setupRequired: false })
    return jsonResponse({})
  })
  onTestFinished(restore)
}

describe('the sign-in screen', () => {
  test('leads with Continue with ChatGPT and keeps the password behind a disclosure', async () => {
    serveSession({ authRequired: true, user: null, signInMethods: { chatgpt: true } })
    render(<AuthGate />)

    const chatgpt = await screen.findByRole('link', { name: 'Continue with ChatGPT' })
    expect(chatgpt.getAttribute('href')).toBe('/api/v1/auth/chatgpt/start?intent=login&returnTo=%2F')
    expect(chatgpt.hasAttribute('data-oai-siwc-button')).toBe(true)
    expect(screen.queryByLabelText('Name')).toBeNull()

    const disclosure = screen.getByRole('button', { name: 'Sign in with a password' })
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText('Name')).toBeTruthy()
    expect(screen.getByLabelText('Password')).toBeTruthy()
    // ChatGPT stays the one primary action: the password submit is the secondary button.
    expect(screen.getByRole('button', { name: 'Sign in' }).className).toContain('border-base')
  })

  test('after a wrong password the disclosure still closes', async () => {
    const restore = installMockFetch((url) => {
      const urlStr = String(url)
      if (urlStr.includes('/api/v1/auth/login')) return jsonResponse({ error: { code: 'AUTH_REQUIRED', message: 'Incorrect name or password.' } }, 401)
      if (urlStr.includes('/api/v1/auth/session')) return jsonResponse({ authRequired: true, user: null, signInMethods: { chatgpt: true } })
      if (urlStr.includes('/api/v1/session')) return jsonResponse({ authenticated: false, setupRequired: false })
      return jsonResponse({})
    })
    onTestFinished(restore)
    render(<AuthGate />)
    const disclosure = await screen.findByRole('button', { name: 'Sign in with a password' })
    fireEvent.click(disclosure)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'arber' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'not-the-password' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText('Incorrect name or password.')).toBeTruthy()

    fireEvent.click(disclosure)
    expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByLabelText('Name')).toBeNull()
  })

  test('without ChatGPT sign-in the name and password form is the screen, as before', async () => {
    serveSession({ authRequired: true, user: null })
    render(<AuthGate />)
    expect(await screen.findByLabelText('Name')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Continue with ChatGPT' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Sign in with a password' })).toBeNull()
  })

  test('says why a ChatGPT sign-in came back, and cleans the address bar', async () => {
    window.history.replaceState(null, '', '/?chatgpt_error=not-invited')
    serveSession({ authRequired: true, user: null, signInMethods: { chatgpt: true } })
    render(<AuthGate />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('has not been invited to this dashboard')
    expect(window.location.search).toBe('')
    // The retry returns to the page without the error in it.
    expect(screen.getByRole('link', { name: 'Continue with ChatGPT' }).getAttribute('href')).toContain('returnTo=%2F')
  })

  test('an unknown return code reads as a plain failure, never as raw text', async () => {
    window.history.replaceState(null, '', '/?chatgpt_error=%3Cscript%3E')
    serveSession({ authRequired: true, user: null, signInMethods: { chatgpt: true } })
    render(<AuthGate />)
    expect((await screen.findByRole('alert')).textContent).toBe('ChatGPT sign-in did not complete. Try again.')
  })
})

const CONNECTED = {
  signInEnabled: true,
  planUsageEnabled: true,
  planRequired: true,
  usageUrl: 'https://chatgpt.com/settings/usage',
  account: { linked: true, email: 'jordan@example.com', plan: { status: 'connected', modelId: null, connectedAt: '2026-11-11T12:00:00.000Z' } },
}

async function renderViewerBar(status: unknown, role: 'viewer' | 'admin' = 'viewer') {
  window.__CANONRY_CONFIG__ = { agent: { allowViewers: true } }
  vi.spyOn(aero, 'fetchAeroTranscript').mockResolvedValue({ messages: [], modelProvider: null, modelId: null, updatedAt: null })
  const project = createDashboardFixture().dashboard.projects[0]!.project
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queryClient.setQueryData(getApiV1ProjectsQueryKey({ client: heyClient }), [project])
  queryClient.setQueryData(
    getApiV1ProjectsByNameAgentProvidersQueryKey({ client: heyClient, path: { name: project.name } }),
    { providers: [{ id: 'openai', label: 'OpenAI', defaultModel: 'gpt-6-luna', configured: true, keySource: 'config' }], defaultProvider: 'openai' },
  )
  queryClient.setQueryData(getApiV1AuthChatgptStatusQueryKey({ client: heyClient }), status)
  queryClient.setQueryData(getApiV1AuthChatgptModelsQueryKey({ client: heyClient }), {
    models: [{ id: 'gpt-6-luna', name: 'GPT-6 Luna' }, { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' }],
    selected: 'gpt-6-luna',
  })
  const rootRoute = createRootRoute({ component: () => (<><AeroBarHost /><Outlet /></>) })
  const projectRoute = createRoute({ getParentRoute: () => rootRoute, path: 'projects/$projectName', component: () => null })
  const router = createRouter({
    routeTree: rootRoute.addChildren([projectRoute]),
    history: createMemoryHistory({ initialEntries: [`/projects/${encodeURIComponent(project.name)}`] }),
  })
  await router.load()
  render(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={{ name: role, role }}>
        <RouterProvider router={router} />
      </AccountProvider>
    </QueryClientProvider>,
  )
  return project
}

describe("a viewer's Aero on their ChatGPT plan", () => {
  test('asks to connect a plan when the install requires one, instead of offering the conversation', async () => {
    await renderViewerBar({ ...CONNECTED, account: { ...CONNECTED.account, plan: { status: 'not-connected', modelId: null, connectedAt: null } } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect ChatGPT to use Aero' }))

    expect(await screen.findByRole('heading', { name: 'Aero answers with your own ChatGPT plan' })).toBeTruthy()
    const connect = screen.getByRole('link', { name: 'Continue with ChatGPT' })
    expect(connect.getAttribute('href')).toContain('/api/v1/auth/chatgpt/start?intent=connect')
    expect(screen.queryByPlaceholderText('Ask Aero, or / for commands…')).toBeNull()
    expect(screen.queryByRole('button', { name: /New conversation/i })).toBeNull()
  })

  test('asks to connect again once the plan stopped working', async () => {
    await renderViewerBar({ ...CONNECTED, account: { ...CONNECTED.account, plan: { status: 'reconnect-required', modelId: null, connectedAt: null } } })
    fireEvent.click(screen.getByRole('button', { name: 'Connect ChatGPT to use Aero' }))
    expect(await screen.findByRole('heading', { name: 'Connect ChatGPT again' })).toBeTruthy()
  })

  test('says whose plan answers and with which model, with usage and the model menu', async () => {
    const project = await renderViewerBar(CONNECTED)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Ask Aero about ${project.name}`, 'i') }))

    const trigger = await screen.findByRole('button', { name: /Answers use your ChatGPT plan/ })
    expect(trigger.textContent).toContain('GPT-6 Luna')
    const usage = screen.getByRole('link', { name: /Manage usage/ })
    expect(usage.getAttribute('href')).toBe('https://chatgpt.com/settings/usage')
    expect(usage.getAttribute('target')).toBe('_blank')
    expect(screen.getByPlaceholderText('Ask Aero, or / for commands…')).toBeTruthy()

    fireEvent.click(trigger)
    const menu = await screen.findByRole('menu', { name: 'ChatGPT plan' })
    expect(within(menu).getByText('ChatGPT · jordan@example.com')).toBeTruthy()
    expect(within(menu).getByRole('menuitemradio', { name: 'GPT-6 Luna' }).getAttribute('aria-checked')).toBe('true')
    expect(within(menu).getByRole('menuitemradio', { name: 'GPT-6.1 Sol' }).getAttribute('aria-checked')).toBe('false')
    expect(within(menu).getByRole('menuitem', { name: 'Disconnect ChatGPT' })).toBeTruthy()
    // Escape closes the menu, not Aero.
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu', { name: 'ChatGPT plan' })).toBeNull())
    expect(screen.getByPlaceholderText('Ask Aero, or / for commands…')).toBeTruthy()
  })

  test('offers the plan quietly where it is optional', async () => {
    const project = await renderViewerBar({ ...CONNECTED, planRequired: false, account: { ...CONNECTED.account, plan: { status: 'not-connected', modelId: null, connectedAt: null } } })
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Ask Aero about ${project.name}`, 'i') }))
    expect((await screen.findByRole('link', { name: 'Use your ChatGPT plan' })).getAttribute('href')).toContain('intent=connect')
    expect(screen.getByPlaceholderText('Ask Aero, or / for commands…')).toBeTruthy()
  })

  test("leaves an administrator's Aero alone", async () => {
    const project = await renderViewerBar(CONNECTED, 'admin')
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`Ask Aero about ${project.name}`, 'i') }))
    await screen.findByPlaceholderText('Ask Aero, or / for commands…')
    expect(screen.queryByText(/Answers use your ChatGPT plan/)).toBeNull()
  })
})

test('reads plan failures from Aero turns, and nothing else', () => {
  expect(parseChatGptTurnError(CHATGPT_AERO_ERRORS.usageLimit)).toEqual({
    kind: 'usage-limit',
    // The URL the server spells out for API callers becomes the Check usage action.
    text: 'Your ChatGPT plan has reached its usage limit for now.',
  })
  expect(parseChatGptTurnError(CHATGPT_AERO_ERRORS.connectRequired)?.kind).toBe('connect')
  expect(parseChatGptTurnError(CHATGPT_AERO_ERRORS.reconnect)?.kind).toBe('reconnect')
  expect(parseChatGptTurnError('Aero could not finish this answer.')).toBeNull()
  expect(parseChatGptTurnError('CHATGPT_SOMETHING_NEW: unknown')).toBeNull()
  expect(parseChatGptTurnError(null)).toBeNull()
})
