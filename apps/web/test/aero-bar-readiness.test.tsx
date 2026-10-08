import { MANAGED_SWEEPS_COPY } from '../src/components/project/ManagedSweepStatus.js'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

test('keeps intermediate responses and renders a completed tool call once, behind its run header', async () => {
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
  expect(screen.getByText('Checking the selected market.')).toBeTruthy()
  // The live event and the persisted call are one step, collapsed under one header.
  const header = screen.getByRole('button', { name: /^1 step/ })
  expect(header.getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText('Read insights')).toBeNull()
  fireEvent.click(header)
  expect(screen.getAllByText('Read insights')).toHaveLength(1)
})

// ── Tool runs ────────────────────────────────────────────────────────
// A run is the tool calls of consecutive assistant messages with no text
// between them. Its header counts real steps; toolkit setup is not one.

interface ScriptedCall {
  id: string
  name: string
  label: string
  durationMs: number
  isError?: boolean
  /** The live start event names no label, as for a tool whose toolkit is not loaded yet. */
  startUnlabelled?: boolean
}
interface ScriptedRound { text?: string; calls: ScriptedCall[] }
type OnAeroEvent = (event: aero.AeroEvent) => void

const LIST_TOOLKITS: ScriptedCall = { id: 'setup-1', name: 'aero_list_toolkits', label: 'Find relevant tools', durationMs: 5 }
const LOAD_TOOLKIT: ScriptedCall = { id: 'setup-2', name: 'aero_load_toolkit', label: 'Load relevant tools', durationMs: 7 }

function readInsights(id: string, durationMs: number, extra: Partial<ScriptedCall> = {}): ScriptedCall {
  return { id, name: 'canonry_insights_list', label: 'Read insights', durationMs, ...extra }
}

function readSentiment(id: string, durationMs: number, extra: Partial<ScriptedCall> = {}): ScriptedCall {
  return { id, name: 'canonry_sentiment_evidence', label: 'Read sentiment evidence', durationMs, ...extra }
}

/**
 * Toolkit setup, then insights, sentiment and insights again, one round each:
 * 3 steps in 120 + 900 + 180 = 1200ms. Setup's 5 + 7ms is not a step's time.
 */
const MULTI_ROUND_RUN: ScriptedRound[] = [
  { calls: [LIST_TOOLKITS] },
  { calls: [LOAD_TOOLKIT] },
  { calls: [readInsights('step-1', 120)] },
  { calls: [readSentiment('step-2', 900)] },
  { calls: [readInsights('step-3', 180)] },
]
const MULTI_ROUND_ANSWER = 'Two insights need attention.'
const MULTI_ROUND_HEADER = '3 steps1.2s'
const SAVED_AT = '2026-10-07T10:00:00.000Z'

function scriptedAssistant(round: ScriptedRound, timestamp: number): aero.AeroAssistantMessage {
  return { role: 'assistant', timestamp, stopReason: 'toolUse', content: [
    ...(round.text ? [{ type: 'text' as const, text: round.text }] : []),
    ...round.calls.map((call) => ({ type: 'toolCall' as const, id: call.id, name: call.name, arguments: {} })),
  ] }
}

function scriptedResult(call: ScriptedCall, timestamp: number): aero.AeroToolResultMessage {
  return {
    role: 'toolResult', timestamp, toolCallId: call.id, isError: call.isError ?? false,
    aeroToolLabel: call.label, aeroDurationMs: call.durationMs, content: [{ type: 'text', text: '{}' }],
  }
}

function finalAnswer(text: string, timestamp = 99): aero.AeroAssistantMessage {
  return { role: 'assistant', timestamp, stopReason: 'stop', content: [{ type: 'text', text }] }
}

function partialAnswer(text: string): aero.AeroEvent {
  return { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text }] }, assistantMessageEvent: {} }
}

/** The transcript the server saves for a scripted turn. */
function scriptedMessages(rounds: ScriptedRound[], answer: string): aero.AeroMessage[] {
  const messages: aero.AeroMessage[] = [{ role: 'user', content: 'Which insights need attention?', timestamp: 1 }]
  rounds.forEach((round, index) => {
    messages.push(scriptedAssistant(round, 10 + index * 10))
    round.calls.forEach((call, offset) => messages.push(scriptedResult(call, 11 + index * 10 + offset)))
  })
  messages.push(finalAnswer(answer))
  return messages
}

function startCall(onEvent: OnAeroEvent, call: ScriptedCall) {
  onEvent({ type: 'tool_execution_start', toolCallId: call.id, toolName: call.name, label: call.startUnlabelled ? undefined : call.label, args: {} })
}

function endCall(onEvent: OnAeroEvent, call: ScriptedCall, timestamp: number) {
  onEvent({ type: 'tool_execution_end', toolCallId: call.id, toolName: call.name, isError: call.isError ?? false, result: {} })
  onEvent({ type: 'message_end', message: scriptedResult(call, timestamp) })
}

/** One round's live events: the message asking for its calls, then each call's start, end and result. */
function emitRound(onEvent: OnAeroEvent, round: ScriptedRound, index: number) {
  onEvent({ type: 'message_end', message: scriptedAssistant(round, 10 + index * 10) })
  for (const call of round.calls) startCall(onEvent, call)
  round.calls.forEach((call, offset) => endCall(onEvent, call, 11 + index * 10 + offset))
}

function gate() {
  let open!: () => void
  const wait = new Promise<void>((resolve) => { open = resolve })
  return { wait, open }
}

/**
 * Stream a scripted turn through the live events, then hold it open after the
 * answer so a test reads the live render before the saved transcript replaces
 * it. `finish` releases the turn and waits for the saved transcript's reload.
 */
function streamScriptedTurn(rounds: ScriptedRound[], answer: string) {
  const transcript = vi.spyOn(aero, 'fetchAeroTranscript').mockResolvedValue(EMPTY_TRANSCRIPT)
  const held = gate()
  vi.spyOn(aero, 'promptAero').mockImplementation(async ({ onEvent }) => {
    rounds.forEach((round, index) => emitRound(onEvent, round, index))
    onEvent({ type: 'message_end', message: finalAnswer(answer) })
    onEvent({ type: 'aero_turn_status', status: { reason: 'completed', toolCalls: 5, modelCalls: rounds.length + 1, durationMs: 1300 } })
    await held.wait
    transcript.mockResolvedValue({ ...EMPTY_TRANSCRIPT, messages: scriptedMessages(rounds, answer), updatedAt: SAVED_AT })
  })
  return {
    async finish() {
      // Still the live turn: nothing has been reloaded yet.
      expect(screen.getByRole('button', { name: 'Stop Aero' })).toBeTruthy()
      const reloads = transcript.mock.calls.length
      await act(async () => { held.open() })
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop Aero' })).toBeNull())
      expect(transcript.mock.calls.length).toBeGreaterThan(reloads)
    },
  }
}

async function openAero() {
  await renderWithProviderReadiness(READY_AERO)
  fireEvent.click(screen.getByRole('button', { name: /Ask Aero/ }))
}

function sendPrompt(prompt: string) {
  fireEvent.change(screen.getByRole('textbox', { name: 'Message Aero' }), { target: { value: prompt } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
}

async function askAero(prompt = 'Which insights need attention?') {
  await openAero()
  sendPrompt(prompt)
}

/** Run headers only: "3 steps…" when done, "Reading insights…" or "Working…" while running. */
function runHeaders() {
  return screen.getAllByRole('button', { name: /^(\d+ (setup )?steps?|[A-Z][a-z]+ing\b[^…]*…)/ })
}

function runPanel(header: HTMLElement) {
  const panel = document.getElementById(header.getAttribute('aria-controls') ?? '')
  expect(panel).not.toBeNull()
  return within(panel as HTMLElement)
}

test('collapses a multi-round tool run into one header that counts real steps, live and saved', async () => {
  const turn = streamScriptedTurn(MULTI_ROUND_RUN, MULTI_ROUND_ANSWER)
  await askAero()
  await screen.findByText(MULTI_ROUND_ANSWER)

  const expectOneCollapsedRun = () => {
    const headers = runHeaders()
    expect(headers).toHaveLength(1)
    expect(headers[0].textContent).toBe(MULTI_ROUND_HEADER)
    expect(headers[0].getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('Read insights')).toBeNull()
    expect(screen.queryByText('Find relevant tools')).toBeNull()
  }
  // The live render of the finished turn, before any reload.
  expectOneCollapsedRun()
  await turn.finish()
  // The saved transcript renders the same run.
  expectOneCollapsedRun()
})

test('an expanded run merges same-label calls in first-seen order and folds toolkit setup out of the step count', async () => {
  const turn = streamScriptedTurn(MULTI_ROUND_RUN, MULTI_ROUND_ANSWER)
  await askAero()
  await screen.findByText(MULTI_ROUND_ANSWER)

  fireEvent.click(runHeaders()[0])
  // One row per label, in the order each label first ran: both insight reads
  // (×2, 120 + 180ms) come before sentiment, which ran between them. Setup is
  // one muted row (5 + 7ms) after the steps.
  const expectRows = () => {
    const [header] = runHeaders()
    expect(header.getAttribute('aria-expanded')).toBe('true')
    expect(runPanel(header).getAllByRole('button').map((row) => row.textContent)).toEqual([
      'Read insights×2done300ms',
      'Read sentiment evidencedone900ms',
      '+ 2 setup stepsdone12ms',
    ])
  }
  expectRows()
  await turn.finish()
  // The reload keeps the run open, with the same rows.
  expectRows()

  const steps = runPanel(runHeaders()[0])
  expect(steps.queryByText('Find relevant tools')).toBeNull()
  fireEvent.click(steps.getByRole('button', { name: /setup steps/ }))
  expect(steps.getByText('Find relevant tools')).toBeTruthy()
  expect(steps.getByText('Load relevant tools')).toBeTruthy()
  fireEvent.click(steps.getByRole('button', { name: /^Read insights/ }))
  // The merged row's title plus each call's own card.
  expect(steps.getAllByText('Read insights')).toHaveLength(3)
})

test('the run header names the step in flight and keeps its open state while the turn streams', async () => {
  const transcript = vi.spyOn(aero, 'fetchAeroTranscript').mockResolvedValue(EMPTY_TRANSCRIPT)
  const loading = gate()
  const between = gate()
  const reading = gate()
  const answering = gate()
  const read = readSentiment('step-1', 900)
  // Whitespace ahead of a message's calls is not text: it neither closes the run nor ends it.
  const rounds: ScriptedRound[] = [{ calls: [LOAD_TOOLKIT] }, { text: '\n\n', calls: [read] }]
  vi.spyOn(aero, 'promptAero').mockImplementation(async ({ onEvent }) => {
    onEvent({ type: 'message_end', message: scriptedAssistant(rounds[0], 10) })
    startCall(onEvent, LOAD_TOOLKIT)
    await loading.wait
    endCall(onEvent, LOAD_TOOLKIT, 11)
    onEvent(partialAnswer('\n\n'))
    await between.wait
    onEvent({ type: 'message_end', message: scriptedAssistant(rounds[1], 20) })
    startCall(onEvent, read)
    await reading.wait
    endCall(onEvent, read, 21)
    onEvent(partialAnswer('Two insights'))
    await answering.wait
    onEvent({ type: 'message_end', message: finalAnswer(MULTI_ROUND_ANSWER) })
    transcript.mockResolvedValue({ ...EMPTY_TRANSCRIPT, messages: scriptedMessages(rounds, MULTI_ROUND_ANSWER), updatedAt: SAVED_AT })
  })
  await askAero()

  // Only toolkit setup is running: no step yet.
  const header = await screen.findByRole('button', { name: /^Loading tools…/ })
  expect(header.getAttribute('aria-expanded')).toBe('false')
  expect(within(header).queryByText(/^step/)).toBeNull()

  // Between steps the run still reads as working, whitespace streaming or not.
  await act(async () => { loading.open() })
  await waitFor(() => expect(within(header).getByText('Working…')).toBeTruthy())
  fireEvent.click(header)
  expect(header.getAttribute('aria-expanded')).toBe('true')

  await act(async () => { between.open() })
  await waitFor(() => expect(within(header).getByText('Reading sentiment evidence…')).toBeTruthy())
  // The ticking clock is shown but kept out of the button's name.
  expect(screen.getByRole('button', { name: /^Reading sentiment evidence…\s*step 1$/ })).toBe(header)
  expect(within(header).getByText(/^\d+s$/)).toBeTruthy()
  expect(runHeaders()).toHaveLength(1)
  // A new step does not close the open run.
  expect(header.getAttribute('aria-expanded')).toBe('true')
  expect(runPanel(header).getByText('running…')).toBeTruthy()

  // Once the answer streams, the run before it is done.
  await act(async () => { reading.open() })
  await screen.findByText('Two insights')
  await waitFor(() => expect(header.textContent).toBe('1 step900ms'))
  expect(header.getAttribute('aria-expanded')).toBe('true')

  await act(async () => { answering.open() })
  await screen.findByText(MULTI_ROUND_ANSWER)
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop Aero' })).toBeNull())
  // The saved transcript's reload keeps the same run, still open.
  const [saved] = runHeaders()
  expect(saved.textContent).toBe('1 step900ms')
  expect(saved.getAttribute('aria-expanded')).toBe('true')
})

test('a two-verb tool label reads as working rather than half a sentence', async () => {
  vi.spyOn(aero, 'fetchAeroTranscript').mockResolvedValue(EMPTY_TRANSCRIPT)
  const clearing = gate()
  const clear: ScriptedCall = { id: 'step-1', name: 'canonry_results_clear', label: 'Preview or clear saved results', durationMs: 30 }
  vi.spyOn(aero, 'promptAero').mockImplementation(async ({ onEvent }) => {
    onEvent({ type: 'message_end', message: scriptedAssistant({ calls: [clear] }, 10) })
    startCall(onEvent, clear)
    await clearing.wait
    endCall(onEvent, clear, 11)
    onEvent({ type: 'message_end', message: finalAnswer('Nothing was cleared.') })
  })
  await askAero()

  expect(await screen.findByRole('button', { name: /^Working…\s*step 1$/ })).toBeTruthy()
  expect(screen.queryByText(/^Previewing or clear/)).toBeNull()
  await act(async () => { clearing.open() })
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop Aero' })).toBeNull())
})

test('a failed step stays visible on the collapsed run header; a failed setup call is not a failed step', async () => {
  const turn = streamScriptedTurn([
    { calls: [{ ...LOAD_TOOLKIT, isError: true }] },
    { calls: [readInsights('step-1', 100), readSentiment('step-2', 50, { isError: true })] },
  ], 'Sentiment could not be read.')
  await askAero()
  await screen.findByText('Sentiment could not be read.')

  const expectFailedRun = () => {
    const [header] = runHeaders()
    expect(header.getAttribute('aria-expanded')).toBe('false')
    // One of two steps failed, in 100 + 50ms. The failed toolkit load adds
    // neither a failure nor time to the steps.
    expect(header.textContent).toBe('2 steps1 failed150ms')
    // The failing call's own card stays folded until the run opens.
    expect(screen.queryByText('Read sentiment evidence')).toBeNull()
    expect(screen.queryByText('failed')).toBeNull()
  }
  expectFailedRun()
  await turn.finish()
  expectFailedRun()

  // The setup row keeps its own failure.
  const [header] = runHeaders()
  fireEvent.click(header)
  expect(runPanel(header).getByRole('button', { name: /setup step/ }).textContent).toBe('+ 1 setup step1 failed7ms')
})

test('a call that streams with no label takes its saved label, so live and saved rows match', async () => {
  // Called before its toolkit loaded: the live start event has no label, the saved result does.
  const turn = streamScriptedTurn([
    { calls: [readInsights('step-1', 5, { isError: true, startUnlabelled: true })] },
    { calls: [LOAD_TOOLKIT] },
    { calls: [readInsights('step-2', 50)] },
  ], MULTI_ROUND_ANSWER)
  await askAero()
  await screen.findByText(MULTI_ROUND_ANSWER)

  fireEvent.click(runHeaders()[0])
  const expectRows = () => {
    const [header] = runHeaders()
    expect(header.textContent).toBe('2 steps1 failed55ms')
    expect(runPanel(header).getAllByRole('button').map((row) => row.textContent)).toEqual([
      'Read insights×21 failed55ms',
      '+ 1 setup stepdone7ms',
    ])
  }
  expectRows()
  await turn.finish()
  expectRows()
})

test('a step row keeps its place, open and focused, when a same-label call joins it', async () => {
  const transcript = vi.spyOn(aero, 'fetchAeroTranscript').mockResolvedValue(EMPTY_TRANSCRIPT)
  const firstDone = gate()
  const held = gate()
  const rounds: ScriptedRound[] = [{ calls: [readInsights('step-1', 120)] }, { calls: [readInsights('step-2', 180)] }]
  vi.spyOn(aero, 'promptAero').mockImplementation(async ({ onEvent }) => {
    emitRound(onEvent, rounds[0], 0)
    await firstDone.wait
    emitRound(onEvent, rounds[1], 1)
    await held.wait
    onEvent({ type: 'message_end', message: finalAnswer(MULTI_ROUND_ANSWER) })
    transcript.mockResolvedValue({ ...EMPTY_TRANSCRIPT, messages: scriptedMessages(rounds, MULTI_ROUND_ANSWER), updatedAt: SAVED_AT })
  })
  await askAero()

  const header = await screen.findByRole('button', { name: /^Working…/ })
  fireEvent.click(header)
  // One call so far: its own card, opened and focused to read its inputs.
  const card = runPanel(header).getByRole('button', { name: /^Read insights/ })
  act(() => { card.focus() })
  fireEvent.click(card)
  expect(card.getAttribute('aria-expanded')).toBe('true')
  expect(runPanel(header).getByText('Inputs')).toBeTruthy()

  await act(async () => { firstDone.open() })
  await waitFor(() => expect(runPanel(header).getAllByRole('button')).toHaveLength(3))
  const [fold, first, second] = runPanel(header).getAllByRole('button')
  // The fold header joins above the same card, which stays mounted, open and focused.
  expect(fold.textContent).toBe('Read insights×2done300ms')
  expect(fold.getAttribute('aria-expanded')).toBe('true')
  expect(first).toBe(card)
  expect(card.isConnected).toBe(true)
  expect(document.activeElement).toBe(card)
  expect(card.getAttribute('aria-expanded')).toBe('true')
  expect(second.getAttribute('aria-expanded')).toBe('false')

  await act(async () => { held.open() })
  await screen.findByText(MULTI_ROUND_ANSWER)
})

test('a saved transcript renders the same collapsed run header as the live turn', async () => {
  vi.spyOn(aero, 'fetchAeroTranscript').mockResolvedValue({
    ...EMPTY_TRANSCRIPT,
    messages: scriptedMessages(MULTI_ROUND_RUN, MULTI_ROUND_ANSWER),
    updatedAt: SAVED_AT,
  })
  await openAero()
  await screen.findByText(MULTI_ROUND_ANSWER)

  const headers = runHeaders()
  expect(headers).toHaveLength(1)
  expect(headers[0].textContent).toBe(MULTI_ROUND_HEADER)
  expect(headers[0].getAttribute('aria-expanded')).toBe('false')
  // Nothing is streaming, so nothing in the saved run is running or interrupted.
  expect(screen.queryByText('interrupted')).toBeNull()
})

test('assistant text between tool calls closes one run and starts the next', async () => {
  vi.spyOn(aero, 'fetchAeroTranscript').mockResolvedValue({
    ...EMPTY_TRANSCRIPT,
    messages: scriptedMessages([
      { calls: [readInsights('step-1', 100)] },
      { text: 'Two insights are open. Checking sentiment next.', calls: [readSentiment('step-2', 200)] },
    ], MULTI_ROUND_ANSWER),
    updatedAt: SAVED_AT,
  })
  await openAero()
  await screen.findByText(MULTI_ROUND_ANSWER)

  const headers = runHeaders()
  expect(headers.map((header) => header.textContent)).toEqual(['1 step100ms', '1 step200ms'])
  const interim = screen.getByText('Two insights are open. Checking sentiment next.')
  // The interim text sits between the two runs, above the calls it introduced.
  expect(headers[0].compareDocumentPosition(interim) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(interim.compareDocumentPosition(headers[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test('a new prompt closes the run before it, even when that turn ended on tool calls', async () => {
  const first = readInsights('step-1', 100)
  const second = readSentiment('step-2', 200)
  vi.spyOn(aero, 'fetchAeroTranscript').mockResolvedValue({
    ...EMPTY_TRANSCRIPT,
    // The first turn hit its tool limit: calls, no text.
    messages: [
      { role: 'user', content: 'Which insights need attention?', timestamp: 1 },
      scriptedAssistant({ calls: [first] }, 10),
      scriptedResult(first, 11),
      { role: 'user', content: 'And sentiment?', timestamp: 20 },
      scriptedAssistant({ calls: [second] }, 30),
      scriptedResult(second, 31),
      finalAnswer(MULTI_ROUND_ANSWER),
    ],
    updatedAt: SAVED_AT,
  })
  await openAero()
  await screen.findByText(MULTI_ROUND_ANSWER)

  const headers = runHeaders()
  expect(headers.map((header) => header.textContent)).toEqual(['1 step100ms', '1 step200ms'])
  const secondPrompt = screen.getByText('And sentiment?')
  expect(headers[0].compareDocumentPosition(secondPrompt) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(secondPrompt.compareDocumentPosition(headers[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
})

test('runs from earlier turns stay settled while a new turn streams', async () => {
  const cutOff = readInsights('cut-1', 0)
  const earlier = readSentiment('done-1', 100)
  const current = readInsights('live-1', 40)
  const savedEarlier: aero.AeroMessage[] = [
    { role: 'user', content: 'Which insights need attention?', timestamp: 1 },
    // Stopped while the model was still asking for a call: no result was saved.
    { role: 'assistant', timestamp: 10, stopReason: 'aborted', content: [
      { type: 'text', text: 'Looking.' },
      { type: 'toolCall', id: cutOff.id, name: cutOff.name, arguments: {} },
    ] },
    { role: 'user', content: 'And sentiment?', timestamp: 20 },
    scriptedAssistant({ calls: [earlier] }, 30),
    scriptedResult(earlier, 31),
    finalAnswer('Sentiment is steady.', 40),
  ]
  const transcript = vi.spyOn(aero, 'fetchAeroTranscript').mockResolvedValue({ ...EMPTY_TRANSCRIPT, messages: savedEarlier, updatedAt: SAVED_AT })
  const inFlight = gate()
  const between = gate()
  vi.spyOn(aero, 'promptAero').mockImplementation(async ({ onEvent }) => {
    onEvent({ type: 'message_end', message: scriptedAssistant({ calls: [current] }, 50) })
    startCall(onEvent, current)
    await inFlight.wait
    endCall(onEvent, current, 51)
    await between.wait
    onEvent({ type: 'message_end', message: finalAnswer('The market held.', 60) })
    transcript.mockResolvedValue({ ...EMPTY_TRANSCRIPT, messages: [
      ...savedEarlier,
      { role: 'user', content: 'And the market?', timestamp: 45 },
      scriptedAssistant({ calls: [current] }, 50),
      scriptedResult(current, 51),
      finalAnswer('The market held.', 60),
    ], updatedAt: '2026-10-07T10:05:00.000Z' })
  })
  await openAero()
  await screen.findByText('Sentiment is steady.')
  expect(runHeaders().map((header) => header.textContent)).toEqual(['1 stepinterrupted', '1 step100ms'])

  sendPrompt('And the market?')
  // The cut-off call is not running again, and the finished run is not waiting on a step.
  const expectEarlierRunsSettled = () => {
    const headers = runHeaders()
    expect(headers).toHaveLength(3)
    expect(headers[0].textContent).toBe('1 stepinterrupted')
    expect(headers[1].textContent).toBe('1 step100ms')
    return headers[2]
  }
  await screen.findByRole('button', { name: /^Reading insights…/ })
  expect(expectEarlierRunsSettled().textContent).toMatch(/^Reading insights…step 1\d+s$/)

  await act(async () => { inFlight.open() })
  await waitFor(() => expect(expectEarlierRunsSettled().textContent).toMatch(/^Working…\d+s$/))

  await act(async () => { between.open() })
  await screen.findByText('The market held.')
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop Aero' })).toBeNull())
  expect(runHeaders().map((header) => header.textContent)).toEqual(['1 stepinterrupted', '1 step100ms', '1 step40ms'])
})

test('shows an error when a turn ends with an error status and no error event', async () => {
  vi.spyOn(aero, 'fetchAeroTranscript').mockResolvedValue(EMPTY_TRANSCRIPT)
  vi.spyOn(aero, 'promptAero').mockImplementation(async ({ onEvent }) => {
    // A wrap-up request that threw: its failure message is filtered, only the status arrives.
    onEvent({ type: 'aero_turn_status', status: { reason: 'error', toolCalls: 30, modelCalls: 12, durationMs: 9 } })
  })
  await renderWithProviderReadiness(READY_AERO)
  fireEvent.click(screen.getByRole('button', { name: /Ask Aero/ }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Message Aero' }), { target: { value: 'Which Properties are most criticized?' } })
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  await screen.findByText('Aero could not finish this answer. Retry to ask again.')
  expect(screen.queryByText(/Tool-call limit reached/)).toBeNull()
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
  const header = screen.getByRole('button', { name: /^1 step/ })
  expect(header.textContent).toBe('1 step640ms')
  expect(screen.queryByText('interrupted')).toBeNull()
  fireEvent.click(header)
  expect(screen.getAllByText('Get project overview (composite)')).toHaveLength(1)
  expect(screen.getByText('done')).toBeTruthy()
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
  expect(screen.getByText('Getting project overview (composite)…')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Stop Aero' }))

  expect(await screen.findByText('Stopped. The sample answer so far is kept.')).toBeTruthy()
  expect(screen.queryByText(/dispatched/)).toBeNull()
  expect(screen.getByText('Checking the latest sweep.')).toBeTruthy()
  // The pill stays on the collapsed header.
  expect(screen.getByRole('button', { name: /^1 step/ }).textContent).toBe('1 stepinterrupted')
  expect(screen.queryByText('The latest sweep completed on all three engines.')).toBeNull()
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  expectNoLiveCalls()
})

test('with motion the demo shows the tool running, then types the answer to completion', async () => {
  await renderPreview({ reducedMotion: false })
  fireEvent.click(screen.getByRole('button', { name: /Ask Aero about citypoint/i }))
  fireEvent.click(await screen.findByRole('button', { name: 'Status' }))

  expect(await screen.findByText('Getting project overview (composite)…')).toBeTruthy()
  expect(screen.getByText('step 1')).toBeTruthy()
  await screen.findByText('The latest sweep completed on all three engines.', {}, { timeout: 4000 })
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Stop Aero' })).toBeNull())
  const header = screen.getByRole('button', { name: /^1 step/ })
  expect(header.textContent).toBe('1 step640ms')
  fireEvent.click(header)
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

test('grows the composer with a multi-line message up to a cap, so its first lines stay in view', async () => {
  vi.spyOn(aero, 'fetchAeroTranscript').mockResolvedValue({ messages: [], modelProvider: null, modelId: null, updatedAt: null })
  let contentHeight = 72
  vi.spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get').mockImplementation(() => contentHeight)
  await renderWithProviderReadiness({
    providers: [{ id: 'openai', label: 'OpenAI', defaultModel: 'gpt-5.4', configured: true, keySource: 'config' }],
    defaultProvider: 'openai',
  }, 'admin')
  fireEvent.click(screen.getByRole('button', { name: /Ask Aero about citypoint/i }))
  const input = screen.getByRole('textbox', { name: 'Message Aero' }) as HTMLTextAreaElement

  fireEvent.change(input, { target: { value: 'line one\nline two\nline three' } })
  expect(input.style.height).toBe('72px')

  contentHeight = 600
  fireEvent.change(input, { target: { value: 'a much longer message\n'.repeat(20) } })
  expect(input.style.height).toBe('144px')
})
