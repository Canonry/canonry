import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { MeasurementChangesResponse } from '@ainyc/canonry-api-client'

import { MeasurementChangesRail } from '../src/components/project/MeasurementChangesRail.js'
import { jsonResponse, mockFetch, pathOf } from './mock-fetch.js'

let restoreFetch: (() => void) | undefined

afterEach(() => {
  cleanup()
  restoreFetch?.()
  restoreFetch = undefined
})

function availableMetric(delta: number) {
  return {
    state: 'available' as const,
    previous: { state: 'available' as const, value: 0.5 },
    current: { state: 'available' as const, value: 0.5 + delta },
    delta,
  }
}

function availableChanges(): MeasurementChangesResponse {
  return {
    current: {
      state: 'complete',
      displayedRunId: 'run-current',
      planRevision: 4,
      completedAt: '2026-08-28T12:00:00.000Z',
      executionIdentity: 'openai:model-a',
      measurementScope: 'full',
    },
    comparison: {
      state: 'available',
      previous: {
        displayedRunId: 'run-previous',
        planRevision: 4,
        completedAt: '2026-08-27T12:00:00.000Z',
        executionIdentity: 'openai:model-a',
        measurementScope: 'full',
      },
      metrics: {
        propertiesMentioned: availableMetric(0.25),
        mentionCoverage: availableMetric(0.125),
        citationCoverage: availableMetric(-0.05),
      },
      changedProperties: [],
      totalProperties: 8,
      truncated: false,
    },
  }
}

function unavailableChanges(reason: 'no_previous_run' | 'incomplete' | 'execution_identity_changed' | 'not_comparable'): MeasurementChangesResponse {
  return {
    current: {
      state: 'complete',
      displayedRunId: 'run-current',
      planRevision: 4,
      completedAt: '2026-08-28T12:00:00.000Z',
      executionIdentity: 'openai:model-a',
      measurementScope: 'full',
    },
    comparison: { state: 'unavailable', reason },
  }
}

function renderRail(
  props: {
    scope?: 'group' | 'property'
    runId?: string
  } = {},
  handler: (url: string) => Response | Promise<Response> = () => jsonResponse(availableChanges()),
) {
  restoreFetch = mockFetch(url => handler(url))
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const shared = {
    project: 'demo',
    queryClass: 'non-brand' as const,
    runId: props.runId ?? 'run-current',
  }
  return render(
    <QueryClientProvider client={queryClient}>
      {props.scope === 'property' ? (
        <MeasurementChangesRail {...shared} scope="property" targetKey="property-a" />
      ) : (
        <MeasurementChangesRail {...shared} scope="group" groupKey="group-a" />
      )}
    </QueryClientProvider>,
  )
}

describe('MeasurementChangesRail', () => {
  it('renders separate signed mention and citation percentage-point deltas for a Group', async () => {
    const requested: string[] = []
    renderRail({}, url => {
      requested.push(url)
      return jsonResponse(availableChanges())
    })

    await screen.findByText('+12.5 pp')
    const rail = screen.getByRole('region', { name: 'Since previous comparable sweep' })
    expect(within(rail).getByText('Mention')).toBeTruthy()
    expect(within(rail).getByText('+12.5 pp')).toBeTruthy()
    expect(within(rail).getByText('Citation')).toBeTruthy()
    expect(within(rail).getByText('-5 pp')).toBeTruthy()
    expect(within(rail).getByText('8 properties changed')).toBeTruthy()

    const query = new URL(requested[0]!).searchParams
    expect(pathOf(requested[0]!)).toContain('/measurement-changes')
    expect(query.get('scope')).toBe('group')
    expect(query.get('groupKey')).toBe('group-a')
    expect(query.get('queryClass')).toBe('non-brand')
    expect(query.get('runId')).toBe('run-current')
  })

  it('keeps Property continuity to the two coverage deltas', async () => {
    renderRail({ scope: 'property' })

    await screen.findByText('+12.5 pp')
    const rail = screen.getByRole('region', { name: 'Since previous comparable sweep' })
    expect(within(rail).getByText('+12.5 pp')).toBeTruthy()
    expect(within(rail).getByText('-5 pp')).toBeTruthy()
    expect(within(rail).queryByText(/properties changed/)).toBeNull()
  })

  it.each([
    ['no_previous_run', 'No comparable sweep yet.'],
    ['incomplete', 'Latest measurement incomplete.'],
    ['execution_identity_changed', 'Answer-engine setup changed.'],
    ['not_comparable', 'Prior sweep differs in scope or setup.'],
  ] as const)('maps %s without inventing a zero', async (reason, copy) => {
    renderRail({}, () => jsonResponse(unavailableChanges(reason)))

    await screen.findByText(copy)
    const rail = screen.getByRole('region', { name: 'Since previous comparable sweep' })
    expect(within(rail).getByText(copy)).toBeTruthy()
    expect(within(rail).queryByText(/0(?:\.0)? pp/)).toBeNull()
  })

  it('marks the local loading section busy', () => {
    renderRail({}, () => new Promise<Response>(() => {}))

    expect(screen.getByRole('region', { name: 'Since previous comparable sweep' }).getAttribute('aria-busy')).toBe('true')
  })

  it('renders a local alert and retries after an error', async () => {
    let attempts = 0
    renderRail({}, () => {
      attempts += 1
      return attempts === 1
        ? jsonResponse({ message: 'temporary failure' }, 500)
        : jsonResponse(availableChanges())
    })

    expect((await screen.findByRole('alert')).textContent).toContain('Could not load measurement changes.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByText('+12.5 pp')
    expect(attempts).toBe(2)
  })

  it('does not retain stale deltas when a new pinned run fails', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    restoreFetch = mockFetch(url => (
      new URL(url).searchParams.get('runId') === 'run-old'
        ? jsonResponse(availableChanges())
        : jsonResponse({ message: 'temporary failure' }, 500)
    ))
    const page = render(
      <QueryClientProvider client={queryClient}>
        <MeasurementChangesRail
          project="demo"
          scope="group"
          groupKey="group-a"
          queryClass="non-brand"
          runId="run-old"
        />
      </QueryClientProvider>,
    )

    await screen.findByText('+12.5 pp')
    page.rerender(
      <QueryClientProvider client={queryClient}>
        <MeasurementChangesRail
          project="demo"
          scope="group"
          groupKey="group-a"
          queryClass="non-brand"
          runId="run-new"
        />
      </QueryClientProvider>,
    )

    await screen.findByRole('alert')
    expect(screen.queryByText('+12.5 pp')).toBeNull()
    expect(screen.queryByText('-5 pp')).toBeNull()
  })
})
