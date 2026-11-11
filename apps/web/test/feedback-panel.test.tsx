import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { UiTelemetryEvent } from '@canonry/canonry-contracts'
import { FeedbackPanel } from '../src/components/shared/FeedbackPanel.js'
import { AccountProvider } from '../src/contexts/account-context.js'
import { heyClient } from '../src/api.js'
import { configureUiTelemetry, resetUiTelemetryForTests, setUiPageFromRoute } from '../src/lib/ui-telemetry.js'
import { jsonResponse, mockFetch } from './mock-fetch.js'
import { openFeedbackPanel } from '../src/lib/feedback-panel.js'

let restoreFetch: (() => void) | undefined
let client: QueryClient
const originalConfig = heyClient.getConfig()

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  delete window.__CANONRY_CONFIG__
  heyClient.setConfig({ baseUrl: 'http://localhost/canonry', apiKey: 'synthetic-key' })
  setUiPageFromRoute('/projects/$projectName/queries')
})
afterEach(() => {
  cleanup()
  client.clear()
  restoreFetch?.()
  restoreFetch = undefined
  heyClient.setConfig(originalConfig)
  resetUiTelemetryForTests()
  delete window.__CANONRY_CONFIG__
  vi.restoreAllMocks()
})

function mount(viewer = false) {
  return render(<QueryClientProvider client={client}>
    <AccountProvider account={viewer ? { name: 'Reader', role: 'viewer' } : null}>
      <FeedbackPanel />
    </AccountProvider>
  </QueryClientProvider>)
}

it('sends one deliberate submission through the SDK with route-pattern context and no text in usage telemetry', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const events: UiTelemetryEvent[] = []
  configureUiTelemetry({ send: async event => { events.push(event); return { accepted: true } } })
  let accept!: (response: Response) => void
  restoreFetch = mockFetch((url, init) => {
    requests.push({ url, init })
    return new Promise(resolve => { accept = resolve })
  })
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Feedback', exact: true }))
  const input = screen.getByRole('textbox', { name: 'Your feedback' })
  expect(document.activeElement).toBe(input)
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Send feedback' }).disabled).toBe(true)
  fireEvent.change(input, { target: { value: '  The query filter is hard to find  ' } })
  fireEvent.change(screen.getByLabelText('About'), { target: { value: 'struggle' } })
  fireEvent.submit(input.closest('form')!)
  fireEvent.submit(input.closest('form')!)
  await waitFor(() => expect(requests).toHaveLength(1))
  expect(requests[0]!.url).toBe('http://localhost/canonry/api/v1/feedback')
  expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
    kind: 'struggle', summary: 'The query filter is hard to find', area: 'dashboard',
    details: 'Screen: /projects/:projectName/queries',
  })
  expect(screen.queryByRole('status')).toBeNull()
  accept(jsonResponse({ accepted: true, id: 'feedback-1' }, 202))
  await screen.findByRole('status')
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({ event: 'ui.action', action: 'feedback.submit' })
  expect(JSON.stringify(events)).not.toContain('query filter')
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  fireEvent.click(screen.getByRole('button', { name: 'Feedback', exact: true }))
  expect(screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Your feedback' }).value).toBe('')
})

it.each([
  [502, { error: { code: 'DELIVERY_FAILED' } }],
  [202, { accepted: false, id: 'no' }],
  [202, null],
  [202, { accepted: true, id: '' }],
])('preserves the message through dismissal and an unconfirmed delivery (%s), then retries explicitly', async (status, body) => {
  let calls = 0
  restoreFetch = mockFetch(() => { calls++; return calls === 1 ? jsonResponse(body, status) : jsonResponse({ accepted: true, id: 'yes' }, 202) })
  mount()
  const trigger = screen.getByRole('button', { name: 'Feedback', exact: true })
  fireEvent.click(trigger)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep my draft' } })
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(document.activeElement).toBe(trigger)
  fireEvent.click(trigger)
  expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('Keep my draft')
  fireEvent.click(screen.getByRole('button', { name: 'Send feedback' }))
  await screen.findByRole('alert')
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getByRole<HTMLTextAreaElement>('textbox').value).toBe('Keep my draft')
  expect(calls).toBe(1)
  fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
  await screen.findByRole('status')
  expect(calls).toBe(2)
})

it.each(['viewer', 'embed', 'demo'] as const)('does not offer feedback in %s mode', mode => {
  if (mode === 'embed') window.__CANONRY_CONFIG__ = { embed: { enabled: true } }
  if (mode === 'demo') window.__CANONRY_CONFIG__ = { demo: { enabled: true, readOnly: true, sampleData: true } }
  const fetch = vi.fn(() => jsonResponse({ accepted: true }))
  restoreFetch = mockFetch(fetch)
  mount(mode === 'viewer')
  expect(screen.queryByRole('button', { name: 'Feedback', exact: true })).toBeNull()
  expect(fetch).not.toHaveBeenCalled()
})

it('opens the same panel when another page asks for it, ready to type', () => {
  mount()
  expect(screen.queryByRole('dialog', { name: 'Share feedback' })).toBeNull()
  act(() => { openFeedbackPanel() })
  expect(screen.getByRole('dialog', { name: 'Share feedback' })).toBeTruthy()
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Your feedback' }))
})

it('stays closed for a viewer, who cannot send feedback, even when another page asks', () => {
  mount(true)
  act(() => { openFeedbackPanel() })
  expect(screen.queryByRole('dialog', { name: 'Share feedback' })).toBeNull()
})
