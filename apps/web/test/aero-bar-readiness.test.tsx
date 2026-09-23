import { MANAGED_SWEEPS_COPY } from '../src/components/project/ManagedSweepStatus.js'
import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { getApiV1ProjectsByNameAgentProvidersQueryKey } from '@ainyc/canonry-api-client/react-query'

import { heyClient } from '../src/api.js'
import * as api from '../src/api.js'
import { AeroBar } from '../src/components/shared/AeroBar.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import * as aero from '../src/api-aero.js'

const PROJECT_NAME = 'citypoint'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  delete window.__CANONRY_CONFIG__
  try {
    window.localStorage.clear()
  } catch {
    // Some Node test workers expose no local storage implementation.
  }
})

async function renderWithProviderReadiness(data: {
  providers: Array<{
    id: 'openai'
    label: string
    defaultModel: string
    configured: boolean
    keySource: 'config' | null
  }>
  defaultProvider: 'openai' | null
}, role: 'admin' | 'viewer' | null = null) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData(
    getApiV1ProjectsByNameAgentProvidersQueryKey({
      client: heyClient,
      path: { name: PROJECT_NAME },
    }),
    data,
  )

  const rootRoute = createRootRoute({
    component: () => (
      <>
        <AeroBar projectName={PROJECT_NAME} />
        <Outlet />
      </>
    ),
  })
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: () => null })
  const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: 'settings', component: () => null })
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, settingsRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()

  const rendered = render(
    <QueryClientProvider client={queryClient}>
      <AccountProvider account={role ? { name: role, role } : null}>
        <RouterProvider router={router} />
      </AccountProvider>
    </QueryClientProvider>,
  )
  return { ...rendered, router }
}

test('does not advertise a working Aero prompt when no agent provider is configured', async () => {
  const { router } = await renderWithProviderReadiness({
    providers: [{
      id: 'openai',
      label: 'OpenAI',
      defaultModel: 'gpt-5.4',
      configured: false,
      keySource: null,
    }],
    defaultProvider: null,
  })

  expect(screen.getByRole('status').textContent).toBe('Aero needs an answer-engine provider.Open Settings')
  expect(screen.queryByRole('button', { name: /Ask Aero/i })).toBeNull()

  fireEvent.click(screen.getByRole('link', { name: 'Open Settings' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/settings'))
})

test('shows the prompt affordance only after provider readiness is confirmed', async () => {
  await renderWithProviderReadiness({
    providers: [{
      id: 'openai',
      label: 'OpenAI',
      defaultModel: 'gpt-5.4',
      configured: true,
      keySource: 'config',
    }],
    defaultProvider: 'openai',
  })

  expect(screen.getByRole('button', { name: /Ask Aero about citypoint/i })).toBeTruthy()
  expect(screen.queryByRole('status')).toBeNull()
})

test('names the missing key when the default provider is a pin with no key', async () => {
  await renderWithProviderReadiness({
    providers: [{ id: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.4', configured: false, keySource: null }],
    defaultProvider: 'openai',
  }, 'admin')

  expect(screen.getByRole('status').textContent).toContain('Aero is set to OpenAI, which has no API key.')
  expect(screen.queryByRole('button', { name: /Ask Aero/i })).toBeNull()
  // Settings cannot add every agent provider's key, so it is not offered.
  expect(screen.queryByRole('link', { name: 'Open Settings' })).toBeNull()
})

test('does not show a view-only user provider state or administrator settings', async () => {
  await renderWithProviderReadiness({
    providers: [{
      id: 'openai',
      label: 'OpenAI',
      defaultModel: 'gpt-5.4',
      configured: false,
      keySource: null,
    }],
    defaultProvider: null,
  }, 'viewer')

  // Which providers exist is operator knowledge, so a viewer's bar never asks
  // and never shows provider state; the server answers each turn or says why not.
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.queryByRole('link', { name: 'Open Settings' })).toBeNull()
  expect(screen.getByRole('button', { name: /Ask Aero about citypoint/i })).toBeTruthy()
})


test('managed sweeps hides the Aero sweep shortcut while retaining read shortcuts', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { managedSweeps: true } }
  await renderWithProviderReadiness({
    providers: [{ id: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.4', configured: true, keySource: 'config' }],
    defaultProvider: 'openai',
  })
  fireEvent.click(screen.getByRole('button', { name: /Ask Aero about citypoint/i }))
  fireEvent.change(screen.getByPlaceholderText('Ask Aero, or / for commands…'), { target: { value: '/' } })
  expect(screen.getByText('/status')).toBeTruthy()
  expect(screen.queryByText('/run-sweep')).toBeNull()
  expect(screen.queryByText('Run sweep now')).toBeNull()
})

test('offers analysis starters, not failed-run or schedule shortcuts', async () => {
  vi.spyOn(aero, 'fetchAeroTranscript').mockResolvedValue({ messages: [], modelProvider: null, modelId: null, updatedAt: null })
  await renderWithProviderReadiness({
    providers: [{ id: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.4', configured: true, keySource: 'config' }],
    defaultProvider: 'openai',
  })
  fireEvent.click(screen.getByRole('button', { name: /Ask Aero about citypoint/i }))
  for (const label of ['Status', 'What changed', 'Biggest gaps', 'Top insights']) {
    expect(await screen.findByRole('button', { name: label })).toBeTruthy()
  }
  expect(screen.queryByRole('button', { name: 'Last failed run' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Schedule' })).toBeNull()

  fireEvent.change(screen.getByPlaceholderText('Ask Aero, or / for commands…'), { target: { value: '/' } })
  expect(screen.getByText('/changes')).toBeTruthy()
  expect(screen.getByText('/gaps')).toBeTruthy()
  expect(screen.queryByText('/last-failed')).toBeNull()
  expect(screen.queryByText('/schedule')).toBeNull()
})

async function openAeroWithSavedWriteScope(managedSweeps: boolean) {
  window.__CANONRY_CONFIG__ = { dashboard: { managedSweeps } }
  vi.stubGlobal('localStorage', { getItem: (key: string) => key.includes(':scope:') ? 'all' : null, setItem: vi.fn(), clear: vi.fn() })
  const transcript = vi.spyOn(aero, 'fetchAeroTranscript').mockResolvedValue({ messages: [], modelProvider: null, modelId: null, updatedAt: null })
  const prompt = vi.spyOn(aero, 'promptAero').mockResolvedValue(undefined)
  await renderWithProviderReadiness({
    providers: [{ id: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.4', configured: true, keySource: 'config' }],
    defaultProvider: 'openai',
  }, 'admin')
  fireEvent.click(screen.getByRole('button', { name: /Ask Aero about citypoint/i }))
  await waitFor(() => expect(transcript).toHaveBeenCalled())
  return { prompt, input: screen.getByPlaceholderText('Ask Aero, or / for commands…') }
}

test.each([
  ['enter', '/run-sweep'], ['submit', '/run-sweep'],
  ['enter', '  /RUN-SWEEP now'], ['submit', '/run-sweep '],
] as const)('managed Aero blocks the typed sweep command through %s (%s)', async (method, draft) => {
  const { prompt, input } = await openAeroWithSavedWriteScope(true)
  fireEvent.change(input, { target: { value: draft } })
  if (method === 'enter') fireEvent.keyDown(input, { key: 'Enter' })
  else fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(await screen.findByText(MANAGED_SWEEPS_COPY)).toBeTruthy()
  expect(prompt).not.toHaveBeenCalled()
})

test.each([false, true])('managed=%s uses the effective Aero scope even with a saved write preference', async managed => {
  const { prompt, input } = await openAeroWithSavedWriteScope(managed)
  // The context strip is gone in every mode, so neither the scope control nor
  // the project/provider line it carried should render.
  expect(screen.queryByRole('button', { name: /Can make changes|Read only/ })).toBeNull()
  expect(screen.queryByText('Read only')).toBeNull()
  // Managed deployments additionally hide the provider picker, and with it the
  // title that named the exact model behind Aero.
  const picker = screen.queryByRole('button', { name: 'Switch agent model' })
  if (managed) {
    expect(picker).toBeNull()
    expect(screen.queryByTitle(/OpenAI/)).toBeNull()
  } else {
    expect(picker).toBeTruthy()
  }
  fireEvent.change(input, { target: { value: 'Show the latest sweep results' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(prompt).toHaveBeenCalledWith(expect.objectContaining({ scope: managed ? 'read-only' : 'all' })))
})

// react-markdown is CommonMark-only: without remark-gfm a piped table has no
// table node at all and renders as one run-on paragraph, which is what the
// styled table/thead/th/td overrides in AeroMarkdown were silently missing.
test('renders a markdown table in an Aero answer', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { managedSweeps: true } }
  vi.spyOn(aero, 'fetchAeroTranscript').mockResolvedValue({
    messages: [{
      role: 'assistant',
      timestamp: 1,
      content: [{
        type: 'text',
        text: '| Property | Mention |\n|---|---|\n| Harbor North | 100% |\n| Lakeside | 58% |',
      }],
    }],
    modelProvider: null,
    modelId: null,
    updatedAt: null,
  } as never)
  await renderWithProviderReadiness({
    providers: [{ id: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.4', configured: true, keySource: 'config' }],
    defaultProvider: 'openai',
  }, 'admin')
  fireEvent.click(screen.getByRole('button', { name: /Ask Aero about citypoint/i }))

  expect(await screen.findByRole('table')).toBeTruthy()
  expect(screen.getByRole('columnheader', { name: 'Property' })).toBeTruthy()
  expect(screen.getByRole('cell', { name: 'Harbor North' })).toBeTruthy()
  expect(screen.getByRole('cell', { name: '58%' })).toBeTruthy()
})

async function openAeroWithSavedProvider(managedSweeps: boolean) {
  window.__CANONRY_CONFIG__ = { dashboard: { managedSweeps } }
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => key.includes(':provider:') ? 'openai' : null,
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
  })
  const transcript = vi.spyOn(aero, 'fetchAeroTranscript').mockResolvedValue({ messages: [], modelProvider: null, modelId: null, updatedAt: null })
  const prompt = vi.spyOn(aero, 'promptAero').mockResolvedValue(undefined)
  await renderWithProviderReadiness({
    providers: [{ id: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.4', configured: true, keySource: 'config' }],
    defaultProvider: 'openai',
  }, 'admin')
  fireEvent.click(screen.getByRole('button', { name: /Ask Aero about citypoint/i }))
  await waitFor(() => expect(transcript).toHaveBeenCalled())
  return { prompt, input: screen.getByPlaceholderText('Ask Aero, or / for commands\u2026') }
}

// The managed dashboard hides the provider picker, so a preference saved
// before managed mode was turned on is one the operator can neither see nor
// clear. It must not keep steering the session: the server persists whatever
// provider a prompt carries.
test.each([false, true])('managed=%s honors a saved provider override only when the picker is visible', async managed => {
  const { prompt, input } = await openAeroWithSavedProvider(managed)
  expect(screen.queryByRole('button', { name: 'Switch agent model' }) === null).toBe(managed)
  fireEvent.change(input, { target: { value: 'Show the latest sweep results' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await waitFor(() => expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
    provider: managed ? undefined : 'openai',
  })))
})

test('operator mode retains the exact Aero sweep shortcut and saved write scope', async () => {
  const { prompt, input } = await openAeroWithSavedWriteScope(false)
  fireEvent.change(input, { target: { value: '/run-sweep' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(prompt).toHaveBeenCalledWith(expect.objectContaining({
    prompt: 'Run a new answer-visibility sweep for this project now and tell me when it lands.', scope: 'all',
  })))
})

const READY_AERO = {
  providers: [{ id: 'openai' as const, label: 'OpenAI', defaultModel: 'model', configured: true, keySource: 'config' as const }],
  defaultProvider: 'openai' as const,
}
const EMPTY_TRANSCRIPT = { messages: [], modelProvider: 'openai', modelId: 'model', updatedAt: null }

test('keeps intermediate responses and renders a completed tool call once', async () => {
  const transcript = vi.spyOn(aero, 'fetchAeroTranscript').mockResolvedValue(EMPTY_TRANSCRIPT)
  vi.spyOn(aero, 'promptAero').mockImplementation(async ({ onEvent }) => {
    const assistant: aero.AeroAssistantMessage = { role: 'assistant', timestamp: 1, content: [
      { type: 'text', text: 'Checking the selected market.' },
      { type: 'toolCall', id: 'call-1', name: 'canonry_insights_list', arguments: {} },
    ] }
    const tool: aero.AeroToolResultMessage = { role: 'toolResult', timestamp: 2, toolCallId: 'call-1', content: [{ type: 'text', text: '[]' }] }
    const answer: aero.AeroAssistantMessage = { role: 'assistant', timestamp: 3, content: [{ type: 'text', text: 'No active insights.' }] }
    onEvent({ type: 'message_end', message: assistant })
    onEvent({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'canonry_insights_list', label: 'Read insights', args: {} })
    onEvent({ type: 'tool_execution_end', toolCallId: 'call-1', toolName: 'canonry_insights_list', isError: false, result: [] })
    onEvent({ type: 'message_end', message: tool })
    onEvent({ type: 'message_end', message: answer })
    onEvent({ type: 'aero_turn_status', status: { reason: 'completed', toolCalls: 1, modelCalls: 2, durationMs: 2 } })
    transcript.mockResolvedValue({ ...EMPTY_TRANSCRIPT, messages: [assistant, tool, answer] })
  })
  await renderWithProviderReadiness(READY_AERO)
  fireEvent.click(screen.getByRole('button', { name: /Ask Aero/ }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Message Aero' }), { target: { value: 'Check this market' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await screen.findByText('No active insights.')
  expect(screen.getAllByText('Read insights')).toHaveLength(1)
  expect(screen.getByText('Checking the selected market.')).toBeTruthy()
})

test('Stop preserves a partial answer and offers an explicit retry', async () => {
  vi.spyOn(aero, 'fetchAeroTranscript').mockResolvedValue(EMPTY_TRANSCRIPT)
  const prompt = vi.spyOn(aero, 'promptAero').mockImplementation(async ({ onEvent, signal }) => {
    onEvent({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'The measured change is' }] }, assistantMessageEvent: {} })
    await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')), { once: true }))
  })
  await renderWithProviderReadiness(READY_AERO)
  fireEvent.click(screen.getByRole('button', { name: /Ask Aero/ }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Message Aero' }), { target: { value: 'Explain this change' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await screen.findByText('The measured change is')
  fireEvent.click(screen.getByRole('button', { name: 'Stop Aero' }))
  await screen.findByText(/Stopped. Partial response preserved/)
  expect(screen.getByText('The measured change is')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  expect(prompt).toHaveBeenCalledTimes(1)
})


test('new conversation preserves history; reopen and explicit delete use distinct controls', async () => {
  const { input } = await openAeroWithSavedWriteScope(true)
  const archived = { id: 'old', title: 'London Property diagnosis', active: false, modelProvider: 'openai', modelId: 'test', createdAt: '2026-09-21T10:00:00Z', updatedAt: '2026-09-21T10:00:00Z' }
  const create = vi.spyOn(api, 'createAgentConversation').mockResolvedValue({ ...archived, id: 'new', active: true, messages: [], isStreaming: false })
  const list = vi.spyOn(api, 'listAgentConversations').mockResolvedValue({ conversations: [archived], currentConversationId: 'new', nextOffset: null })
  const resume = vi.spyOn(api, 'resumeAgentConversation').mockResolvedValue({ ...archived, active: true, messages: [], isStreaming: false })
  const remove = vi.spyOn(api, 'deleteAgentConversation').mockResolvedValue({ id: 'old', status: 'deleted' })
  expect(screen.queryByRole('button', { name: 'Reset conversation' })).toBeNull()
  fireEvent.change(input, { target: { value: 'Unsent draft' } })
  fireEvent.click(screen.getByRole('button', { name: 'New conversation' }))
  await waitFor(() => expect(create).toHaveBeenCalledWith(PROJECT_NAME, expect.stringMatching(/^[a-f0-9-]{36}$/)))
  await waitFor(() => expect(screen.getByRole('button', { name: 'History' }).hasAttribute('disabled')).toBe(false))
  expect((input as HTMLTextAreaElement).value).toBe('Unsent draft')
  fireEvent.click(screen.getByRole('button', { name: 'History' }))
  await screen.findByRole('button', { name: /London Property diagnosis.*2026/ })
  expect(screen.getByLabelText('Message Aero').hasAttribute('disabled')).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: /London Property diagnosis.*2026/ }))
  await waitFor(() => expect(resume).toHaveBeenCalledWith(PROJECT_NAME, 'old'))
  await waitFor(() => expect(screen.getByRole('button', { name: 'History' }).hasAttribute('disabled')).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'History' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Delete conversation: London Property diagnosis' }))
  expect(remove).not.toHaveBeenCalled()
  expect(screen.getByText('Delete this conversation permanently? Shared project notes will be kept.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(remove).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Delete conversation: London Property diagnosis' }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete conversation' }))
  await waitFor(() => expect(remove).toHaveBeenCalledWith(PROJECT_NAME, 'old'))
  expect(list).toHaveBeenCalled()
})

test('history failures remain visible', async () => {
  await openAeroWithSavedWriteScope(true)
  vi.spyOn(api, 'listAgentConversations').mockRejectedValue(new Error('History unavailable'))
  fireEvent.click(screen.getByRole('button', { name: 'History' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'History unavailable')
})

// A conversation's stored provider is provenance. Saving it as the dashboard's
// choice would make every later prompt name it, which outranks the server pin.
test('reopening a conversation does not save its provider as the dashboard choice', async () => {
  window.__CANONRY_CONFIG__ = { dashboard: { managedSweeps: false } }
  const setItem = vi.fn()
  vi.stubGlobal('localStorage', { getItem: () => null, setItem, removeItem: vi.fn(), clear: vi.fn() })
  vi.spyOn(aero, 'fetchAeroTranscript').mockResolvedValue({ messages: [], modelProvider: null, modelId: null, updatedAt: null })
  const archived = { id: 'old', title: 'London Property diagnosis', active: false, modelProvider: 'openai', modelId: 'test', createdAt: '2026-09-21T10:00:00Z', updatedAt: '2026-09-21T10:00:00Z' }
  vi.spyOn(api, 'listAgentConversations').mockResolvedValue({ conversations: [archived], currentConversationId: 'new', nextOffset: null })
  const resume = vi.spyOn(api, 'resumeAgentConversation').mockResolvedValue({ ...archived, active: true, messages: [], isStreaming: false })
  await renderWithProviderReadiness({
    providers: [{ id: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.4', configured: true, keySource: 'config' }],
    defaultProvider: 'openai',
  }, 'admin')
  fireEvent.click(screen.getByRole('button', { name: /Ask Aero about citypoint/i }))
  fireEvent.click(await screen.findByRole('button', { name: 'History' }))
  fireEvent.click(await screen.findByRole('button', { name: /London Property diagnosis.*2026/ }))
  await waitFor(() => expect(resume).toHaveBeenCalledWith(PROJECT_NAME, 'old'))
  await waitFor(() => expect(screen.getByRole('button', { name: 'History' }).hasAttribute('disabled')).toBe(false))
  expect(setItem.mock.calls.filter(([key]) => String(key).includes(':provider:'))).toEqual([])
})
