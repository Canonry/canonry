import React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ExplanationBody, WhyThisPanel } from '../src/pages/ReportPage.js'
import { mockFetch, jsonResponse, pathOf } from './mock-fetch.js'

afterEach(cleanup)

function renderPanel(targetRef = 'tgt_abc123') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const onClose = vi.fn()
  return {
    onClose,
    ...render(
      <QueryClientProvider client={queryClient}>
        <WhyThisPanel projectName="acme" targetRef={targetRef} onClose={onClose} />
      </QueryClientProvider>,
    ),
  }
}

// ─── ExplanationBody ────────────────────────────────────────────────────────

test('ExplanationBody renders dash-prefixed lines as a bulleted list', () => {
  render(<ExplanationBody text={'- Competitors cited\n- Write a guide\n- Win citations'} />)
  const items = screen.getAllByRole('listitem')
  expect(items).toHaveLength(3)
  expect(items[0]!.textContent).toBe('Competitors cited')
  expect(items[2]!.textContent).toBe('Win citations')
})

test('ExplanationBody falls back to paragraphs when no bullets are present', () => {
  render(<ExplanationBody text={'Plain explanation paragraph.'} />)
  expect(screen.queryByRole('listitem')).toBeNull()
  expect(screen.getByText('Plain explanation paragraph.')).toBeTruthy()
})

test('ExplanationBody renders bullets + paragraphs together', () => {
  render(<ExplanationBody text={'Some context paragraph.\n- bullet one\n- bullet two'} />)
  expect(screen.getByText('Some context paragraph.')).toBeTruthy()
  expect(screen.getAllByRole('listitem')).toHaveLength(2)
})

// ─── WhyThisPanel ───────────────────────────────────────────────────────────

const cachedResponse = {
  targetRef: 'tgt_abc123',
  promptVersion: 'v1',
  provider: 'claude',
  model: 'claude-sonnet-4-6',
  responseText: '- Cached reason\n- Cached action\n- Cached outcome',
  costMillicents: 42,
  generatedAt: '2026-05-18T01:23:45.000Z',
}

const freshResponse = {
  targetRef: 'tgt_abc123',
  promptVersion: 'v1',
  provider: 'gemini',
  model: 'gemini-2.5-flash',
  responseText: '- Fresh reason\n- Fresh action\n- Fresh outcome',
  costMillicents: 7,
  generatedAt: '2026-05-18T01:24:00.000Z',
}

test('hydrates from cached analysis when GET returns 200', async () => {
  const restoreFetch = mockFetch((url) => {
    const path = pathOf(url)
    if (path.endsWith('/projects/acme/content/recommendations/tgt_abc123/analysis')) {
      return jsonResponse(cachedResponse)
    }
    throw new Error(`unexpected fetch: ${path}`)
  })
  try {
    renderPanel()
    await waitFor(() => {
      expect(screen.getByText('Cached reason')).toBeTruthy()
    })
    // Should not have triggered POST — cache was warm.
    expect(screen.queryByText('Analyzing recommendation…')).toBeNull()
    // Footer should show provider + model + cost (in cents).
    expect(screen.getByText(/claude-sonnet-4-6/)).toBeTruthy()
    // 42 millicents / 1000 = 0.042 cents → renders as ~0.0420¢
    expect(screen.getByText(/0\.0420¢/)).toBeTruthy()
  } finally {
    restoreFetch()
  }
})

test('falls through to POST analyze when GET 404s', async () => {
  let postCount = 0
  const restoreFetch = mockFetch((url, init) => {
    const path = pathOf(url)
    if (path.endsWith('/projects/acme/content/recommendations/tgt_abc123/analysis')) {
      return jsonResponse({ error: { code: 'NOT_FOUND', message: 'none' } }, 404)
    }
    if (
      path.endsWith('/projects/acme/content/recommendations/tgt_abc123/analyze')
      && init?.method === 'POST'
    ) {
      postCount++
      return jsonResponse(cachedResponse)
    }
    throw new Error(`unexpected fetch: ${path}`)
  })
  try {
    renderPanel()
    await waitFor(() => {
      expect(screen.getByText('Cached reason')).toBeTruthy()
    })
    expect(postCount).toBe(1)
  } finally {
    restoreFetch()
  }
})

test('renders error state when analyze fails after a GET 404', async () => {
  const restoreFetch = mockFetch((url, init) => {
    const path = pathOf(url)
    if (path.endsWith('/projects/acme/content/recommendations/tgt_abc123/analysis')) {
      return jsonResponse({ error: { code: 'NOT_FOUND', message: 'none' } }, 404)
    }
    if (path.endsWith('/projects/acme/content/recommendations/tgt_abc123/analyze') && init?.method === 'POST') {
      return jsonResponse(
        { error: { code: 'PROVIDER_ERROR', message: 'No provider configured' } },
        502,
      )
    }
    throw new Error(`unexpected fetch: ${path}`)
  })
  try {
    renderPanel()
    await waitFor(() => {
      // The error toast text comes from ApiError.message which formats as
      // "<code>: <message>" via the global handler. Match the substring.
      expect(screen.getByText(/No provider configured/i)).toBeTruthy()
    })
    expect(screen.getByText(/Try again/i)).toBeTruthy()
  } finally {
    restoreFetch()
  }
})

test('regenerate button forces a fresh POST with forceRefresh=true', async () => {
  const analyzeBodies: string[] = []
  const restoreFetch = mockFetch((url, init) => {
    const path = pathOf(url)
    if (path.endsWith('/projects/acme/content/recommendations/tgt_abc123/analysis')) {
      return jsonResponse(cachedResponse)
    }
    if (path.endsWith('/projects/acme/content/recommendations/tgt_abc123/analyze') && init?.method === 'POST') {
      analyzeBodies.push(typeof init.body === 'string' ? init.body : '')
      return jsonResponse(freshResponse)
    }
    throw new Error(`unexpected fetch: ${path}`)
  })
  try {
    renderPanel()
    await waitFor(() => expect(screen.getByText('Cached reason')).toBeTruthy())
    const regenerate = screen.getByRole('button', { name: /Regenerate/i })
    await act(async () => {
      fireEvent.click(regenerate)
    })
    await waitFor(() => expect(screen.getByText('Fresh reason')).toBeTruthy())
    expect(analyzeBodies).toHaveLength(1)
    const body = JSON.parse(analyzeBodies[0]!) as { forceRefresh?: boolean; provider?: string }
    expect(body.forceRefresh).toBe(true)
    expect(body.provider).toBeUndefined() // no override picked
  } finally {
    restoreFetch()
  }
})

test('changing the provider dropdown triggers an immediate regenerate with that provider', async () => {
  let lastBody: { forceRefresh?: boolean; provider?: string } | null = null
  const restoreFetch = mockFetch((url, init) => {
    const path = pathOf(url)
    if (path.endsWith('/projects/acme/content/recommendations/tgt_abc123/analysis')) {
      return jsonResponse(cachedResponse)
    }
    if (path.endsWith('/projects/acme/content/recommendations/tgt_abc123/analyze') && init?.method === 'POST') {
      lastBody = JSON.parse(typeof init.body === 'string' ? init.body : '{}')
      return jsonResponse({ ...freshResponse, provider: 'openai', model: 'gpt-5-mini' })
    }
    throw new Error(`unexpected fetch: ${path}`)
  })
  try {
    renderPanel()
    await waitFor(() => expect(screen.getByText('Cached reason')).toBeTruthy())
    const select = screen.getByLabelText(/Provider/i) as HTMLSelectElement
    await act(async () => {
      fireEvent.change(select, { target: { value: 'openai' } })
    })
    await waitFor(() => expect(screen.getByText('Fresh reason')).toBeTruthy())
    expect(lastBody).not.toBeNull()
    expect(lastBody!.provider).toBe('openai')
    expect(lastBody!.forceRefresh).toBe(true)
  } finally {
    restoreFetch()
  }
})

test('Hide button calls onClose', async () => {
  const restoreFetch = mockFetch((url) => {
    const path = pathOf(url)
    if (path.endsWith('/projects/acme/content/recommendations/tgt_abc123/analysis')) {
      return jsonResponse(cachedResponse)
    }
    throw new Error(`unexpected fetch: ${path}`)
  })
  try {
    const { onClose } = renderPanel()
    await waitFor(() => expect(screen.getByText('Cached reason')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /^Hide$/ }))
    expect(onClose).toHaveBeenCalled()
  } finally {
    restoreFetch()
  }
})
