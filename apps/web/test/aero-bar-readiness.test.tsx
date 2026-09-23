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
import { AccountProvider, type ApiKeyAccess } from '../src/contexts/account-context.js'
import * as aero from '../src/api-aero.js'
import type { AeroPreviewResponse } from '@ainyc/canonry-contracts'

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
} | null, role: 'admin' | 'viewer' | null = null, apiKey?: ApiKeyAccess) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (data) {
    queryClient.setQueryData(
      getApiV1ProjectsByNameAgentProvidersQueryKey({
        client: heyClient,
        path: { name: PROJECT_NAME },
      }),
      data,
    )
  }

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
      <AccountProvider account={role ? { name: role, role } : null} apiKey={apiKey}>
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

test('fits the slash palette to the room above the composer so no command is cut off', async () => {
  vi.spyOn(aero, 'fetchAeroTranscript').mockResolvedValue({ messages: [], modelProvider: null, modelId: null, updatedAt: null })
  // Panel top at 100px, composer at 300px, palette header 20px: 300 - 100 - 16 - 20 = 164px of list.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = this.hasAttribute('data-aero-panel') ? 100 : this.querySelector(':scope > form') ? 300 : 0
    const height = this.textContent === 'Commands' ? 20 : 0
    return { top, height, bottom: top + height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect
  })
  await renderWithProviderReadiness({
    providers: [{ id: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.4', configured: true, keySource: 'config' }],
    defaultProvider: 'openai',
  }, 'admin')
  fireEvent.click(screen.getByRole('button', { name: /Ask Aero about citypoint/i }))
  fireEvent.change(screen.getByPlaceholderText('Ask Aero, or / for commands…'), { target: { value: '/' } })

  const list = screen.getByRole('listbox')
  expect(list.style.maxHeight).toBe('164px')
  expect(screen.getByText('/status')).toBeTruthy()
})

// ── Public demo preview ──────────────────────────────────────────────
// The demo has no agent routes and no model. Its bar plays the demo server's
// scripted answers, and must never reach a live Aero endpoint.

const DEMO_KEY: ApiKeyAccess = { id: 'public-demo-viewer', scopes: ['read'], projectId: null, readOnly: false }
const PREVIEW_URL = `/api/v1/projects/${PROJECT_NAME}/agent/preview`
const STATUS_PROMPT = 'Give me a quick status: the latest sweep, which engines answered, and anything that needs attention.'
const PREVIEW: AeroPreviewResponse = {
  project: PROJECT_NAME,
  seededAt: '2026-09-23T12:00:00.000Z',
  starters: [
    {
      id: 'status',
      steps: [{
        text: 'Checking the latest sweep.',
        tool: {
          name: 'canonry_project_overview',
          label: 'Get project overview (composite)',
          arguments: { project: PROJECT_NAME },
          result: { latestRun: { status: 'completed' } },
          durationMs: 640,
        },
      }],
      answer: 'The latest sweep completed on all three engines.',
    },
    { id: 'changes', steps: [], answer: 'Nothing moved beyond normal run-to-run noise.' },
    { id: 'gaps', steps: [], answer: 'Two tracked queries have no mention from any engine.' },
    { id: 'insights', steps: [], answer: 'Three medium insights lead the list.' },
  ],
}

async function renderPreview({ reducedMotion = true } = {}) {
  window.__CANONRY_CONFIG__ = { demo: { enabled: true, readOnly: true, sampleData: true }, dashboard: { showAgentBar: false } }
  if (reducedMotion) vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: true }))
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith(PREVIEW_URL)) return new Response(JSON.stringify(PREVIEW), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ error: { code: 'DEMO_READ_ONLY', message: 'unavailable in the view-only demo' } }), { status: 403 })
  })
  vi.stubGlobal('fetch', fetchMock)
  const live = [
    vi.spyOn(aero, 'fetchAeroTranscript'),
    vi.spyOn(aero, 'fetchAgentProviders'),
    vi.spyOn(aero, 'promptAero'),
    vi.spyOn(aero, 'resetAeroTranscript'),
    vi.spyOn(api, 'listAgentConversations'),
    vi.spyOn(api, 'createAgentConversation'),
    vi.spyOn(api, 'resumeAgentConversation'),
  ]
  // No provider readiness is seeded: the preview must not wait on that check.
  const rendered = await renderWithProviderReadiness(null, null, DEMO_KEY)
  const requestedUrls = () => fetchMock.mock.calls.map(([input]) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url))
  const expectNoLiveCalls = () => {
    for (const spy of live) expect(spy).not.toHaveBeenCalled()
    for (const url of requestedUrls()) expect(url).toMatch(/\/agent\/preview$/)
  }
  return { ...rendered, fetchMock, requestedUrls, expectNoLiveCalls }
}

test('the demo preview shows the bar with no provider check and no operator controls', async () => {
  const { requestedUrls, expectNoLiveCalls } = await renderPreview()
  expect(screen.queryByRole('status')).toBeNull()
  expect(requestedUrls()).toEqual([])

  fireEvent.click(screen.getByRole('button', { name: /Ask Aero about citypoint/i }))
  await waitFor(() => expect(requestedUrls()).toEqual([PREVIEW_URL]))
  expect(screen.getByRole('button', { name: /New conversation/i })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /History/i })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Switch agent model' })).toBeNull()
  expect(screen.getByPlaceholderText('Type / for a starting point')).toBeTruthy()

  expect(screen.getByText(/Sample answers on demo data\./)).toBeTruthy()
  const site = screen.getByRole('link', { name: /Aero answers from your own Canonry data\./ })
  expect(site.getAttribute('href')).toBe('https://canonry.ai')
  expect(site.getAttribute('target')).toBe('_blank')
  expect(site.getAttribute('rel')).toBe('noopener noreferrer')
  expectNoLiveCalls()
})

test('a demo starter plays its scripted answer, shows the tool once and completes', async () => {
  const { requestedUrls, expectNoLiveCalls } = await renderPreview()
  fireEvent.click(screen.getByRole('button', { name: /Ask Aero about citypoint/i }))
  fireEvent.click(await screen.findByRole('button', { name: 'Status' }))

  await screen.findByText('The latest sweep completed on all three engines.')
  expect(screen.getByText(STATUS_PROMPT)).toBeTruthy()
  expect(screen.getByText('Checking the latest sweep.')).toBeTruthy()
  expect(screen.getAllByText('Get project overview (composite)')).toHaveLength(1)
  expect(screen.getByText('done')).toBeTruthy()
  expect(screen.getByText('640ms')).toBeTruthy()
  expect(screen.queryByText('interrupted')).toBeNull()
  // Nothing an operator would run elsewhere: the demo has no CLI to paste into.
  expect(screen.queryByRole('button', { name: 'Copy as CLI command' })).toBeNull()
  // The starters stay in reach once an answer is in.
  for (const label of ['Status', 'What changed', 'Biggest gaps', 'Top insights']) {
    expect(screen.getByRole('button', { name: label })).toBeTruthy()
  }

  fireEvent.click(screen.getByRole('button', { name: 'Top insights' }))
  await screen.findByText('Three medium insights lead the list.')
  expect(requestedUrls()).toEqual([PREVIEW_URL])
  expectNoLiveCalls()
})

test('the demo palette lists only the four starters and plays the one picked', async () => {
  const { expectNoLiveCalls } = await renderPreview()
  fireEvent.click(screen.getByRole('button', { name: /Ask Aero about citypoint/i }))
  fireEvent.change(screen.getByPlaceholderText('Type / for a starting point'), { target: { value: '/' } })

  const options = screen.getAllByRole('option').map((option) => option.textContent)
  expect(options).toEqual(['Status/status', 'What changed/changes', 'Biggest gaps/gaps', 'Top insights/insights'])
  expect(screen.getByText('Starting points')).toBeTruthy()
  for (const hidden of ['/last-run', '/run-sweep', '/queries', '/competitors', '/new']) {
    expect(screen.queryByText(hidden)).toBeNull()
  }

  fireEvent.click(screen.getByRole('option', { name: /What changed/ }))
  await screen.findByText('Nothing moved beyond normal run-to-run noise.')

  // A command typed in full plays its starter too.
  const input = screen.getByPlaceholderText('Type / for a starting point')
  fireEvent.change(input, { target: { value: '/gaps ' } })
  fireEvent.keyDown(input, { key: 'Enter' })
  await screen.findByText('Two tracked queries have no mention from any engine.')
  expectNoLiveCalls()
})

test('the demo never sends free text', async () => {
  const { expectNoLiveCalls } = await renderPreview()
  fireEvent.click(screen.getByRole('button', { name: /Ask Aero about citypoint/i }))
  const input = screen.getByPlaceholderText('Type / for a starting point')
  fireEvent.change(input, { target: { value: 'How are we doing on roof repair?' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))

  expect(await screen.findByText('This demo plays sample answers only. Pick a starting point, or type / to choose one.')).toBeTruthy()
  expect(screen.queryByText('You')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
  expectNoLiveCalls()
})

test('New conversation in the demo clears the page only', async () => {
  const { expectNoLiveCalls } = await renderPreview()
  fireEvent.click(screen.getByRole('button', { name: /Ask Aero about citypoint/i }))
  fireEvent.click(await screen.findByRole('button', { name: 'Status' }))
  await screen.findByText('The latest sweep completed on all three engines.')

  fireEvent.click(screen.getByRole('button', { name: /New conversation/i }))
  expect(screen.queryByText('The latest sweep completed on all three engines.')).toBeNull()
  expect(screen.getByText(/See how Aero answers about/)).toBeTruthy()
  expectNoLiveCalls()
})

test('Stop in the demo keeps the partial answer and says nothing was left running', async () => {
  const { expectNoLiveCalls } = await renderPreview({ reducedMotion: false })
  fireEvent.click(screen.getByRole('button', { name: /Ask Aero about citypoint/i }))
  fireEvent.click(await screen.findByRole('button', { name: 'Status' }))

  await screen.findByText('Checking the latest sweep.')
  expect(screen.getByText('running…')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Stop Aero' }))

  expect(await screen.findByText('Stopped. The sample answer so far is kept.')).toBeTruthy()
  expect(screen.queryByText(/dispatched/)).toBeNull()
  expect(screen.getByText('Checking the latest sweep.')).toBeTruthy()
  expect(screen.getByText('interrupted')).toBeTruthy()
  expect(screen.queryByText('The latest sweep completed on all three engines.')).toBeNull()
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  expectNoLiveCalls()
})

test('with motion the demo shows the tool running, then types the answer to completion', async () => {
  await renderPreview({ reducedMotion: false })
  fireEvent.click(screen.getByRole('button', { name: /Ask Aero about citypoint/i }))
  fireEvent.click(await screen.findByRole('button', { name: 'Status' }))

  expect(await screen.findByText('running…')).toBeTruthy()
  await screen.findByText('The latest sweep completed on all three engines.', {}, { timeout: 4000 })
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop Aero' })).toBeNull())
  expect(screen.getByText('done')).toBeTruthy()
  expect(screen.getAllByText('Get project overview (composite)')).toHaveLength(1)
})

test('unmounting the demo bar stops playback', async () => {
  const { unmount } = await renderPreview({ reducedMotion: false })
  const abort = vi.spyOn(AbortController.prototype, 'abort')
  fireEvent.click(screen.getByRole('button', { name: /Ask Aero about citypoint/i }))
  fireEvent.click(await screen.findByRole('button', { name: 'Status' }))
  await screen.findByText('Checking the latest sweep.')
  unmount()
  expect(abort).toHaveBeenCalled()
})
