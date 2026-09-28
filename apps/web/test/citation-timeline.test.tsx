import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'

import { CitationTimeline } from '../src/components/project/CitationTimeline.js'

afterEach(cleanup)

test('shows one date for a single observation and retains its latest-run signal', () => {
  const createdAt = '2026-07-01T12:00:00.000Z'
  render(<CitationTimeline signal="mentions" history={[
    { runId: 'run-1', citationState: 'cited', createdAt },
  ]} />)
  const date = new Date(createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const timeline = screen.getByRole('img')
  expect(timeline.textContent).toBe(`${date} latest`)
  expect(timeline.getAttribute('aria-label')).toBe(`Mention history across 1 run. Latest run, ${new Date(createdAt).toLocaleDateString()}: mentioned`)
})

test('exposes citation history to assistive technology and uses distinct shapes', () => {
  const { container } = render(
    <CitationTimeline
      history={[
        { runId: 'run-1', citationState: 'cited', createdAt: '2026-07-01T12:00:00.000Z' },
        { runId: 'run-2', citationState: 'not-cited', createdAt: '2026-07-08T12:00:00.000Z' },
        { runId: 'run-3', citationState: 'lost', createdAt: '2026-07-14T12:00:00.000Z' },
      ]}
    />,
  )

  const timeline = screen.getByRole('img', { name: /citation history across 3 runs/i })
  expect(timeline.getAttribute('aria-label')).toContain('cited')
  expect(timeline.getAttribute('aria-label')).toContain('not cited')
  expect(timeline.getAttribute('aria-label')).toContain('lost')
  expect(container.querySelector('.rounded-full')).not.toBeNull()
  expect(container.querySelector('.rounded-sm')).not.toBeNull()
  expect(container.querySelector('.rotate-45')).not.toBeNull()
})

test.each([
  { signal: 'mentions' as const, heading: 'Mention', states: ['mentioned', 'not mentioned', 'mention lost', 'new mention', 'mention pending'] },
  { signal: 'citations' as const, heading: 'Citation', states: ['cited', 'not cited', 'citation lost', 'new citation', 'citation pending'] },
])('names every projected state and tooltip for $signal independently', ({ signal, heading, states }) => {
  const history = ['cited', 'not-cited', 'lost', 'emerging', 'pending'].map((citationState, index) => ({
    runId: `run-${index}`,
    citationState,
    createdAt: `2026-07-0${index + 1}T12:00:00.000Z`,
    model: index === 4 ? 'saved-model' : null,
  }))
  const { container } = render(<CitationTimeline history={history} signal={signal} />)
  const entries = history.map((point, index) => `${index === 4 ? 'Latest run, ' : ''}${new Date(point.createdAt).toLocaleDateString()}: ${states[index]}${point.model ? `, model ${point.model}` : ''}`)
  expect(screen.getByRole('img').getAttribute('aria-label')).toBe(`${heading} history across 5 runs. ${entries.join('; ')}`)
  const dots = [...container.querySelectorAll('[title]')].filter(element => element.getAttribute('title')?.includes(' · '))
  expect(dots.map(dot => dot.getAttribute('title')?.split(' · ')[0])).toEqual(states)
})

test('marks the newest run, and only the newest run', () => {
  const { container } = render(
    <CitationTimeline
      history={[
        { runId: 'run-1', citationState: 'cited', createdAt: '2026-07-01T12:00:00.000Z' },
        { runId: 'run-2', citationState: 'cited', createdAt: '2026-07-08T12:00:00.000Z' },
        { runId: 'run-3', citationState: 'cited', createdAt: '2026-07-14T12:00:00.000Z' },
      ]}
    />,
  )

  const marked = container.querySelectorAll('.outline-mono-400')
  expect(marked).toHaveLength(1)
  expect(marked[0]!.getAttribute('title')).toContain('latest run')
  // The marker is on the newest point, which is rendered last.
  const allDots = container.querySelectorAll('[title]')
  expect(allDots[allDots.length - 1]).toBe(marked[0])
  expect(screen.getByRole('img').getAttribute('aria-label')).toContain('Latest run')
})

test('a mid-history model change never reads as the current run', () => {
  // The reported confusion: several sweeps land on one day, the model changes
  // on the first of them, and the "model changed" ring was the only marker in
  // the strip. It sat four dots from the right while the newest run had no
  // marker at all.
  const { container } = render(
    <CitationTimeline
      history={[
        { runId: 'run-1', citationState: 'cited', createdAt: '2026-07-20T12:00:00.000Z', model: 'old-model' },
        { runId: 'run-2', citationState: 'cited', createdAt: '2026-07-29T17:23:00.000Z', model: 'new-model' },
        { runId: 'run-3', citationState: 'cited', createdAt: '2026-07-29T17:39:00.000Z', model: 'new-model' },
        { runId: 'run-4', citationState: 'cited', createdAt: '2026-07-29T17:51:00.000Z', model: 'new-model' },
      ]}
    />,
  )

  const dots = [...container.querySelectorAll('[title]')].filter(el => el.getAttribute('title')?.includes('·'))
  expect(dots).toHaveLength(4)
  // The model-changed ring stays where the model actually changed...
  expect(dots[1]!.getAttribute('title')).toContain('model changed')
  expect(dots[1]!.className).not.toContain('outline-mono-400')
  // ...and the newest run is marked independently of it.
  expect(dots[3]!.getAttribute('title')).toContain('latest run')
  expect(dots[3]!.getAttribute('title')).not.toContain('model changed')
  expect(dots[3]!.className).toContain('outline-mono-400')
})

test('a run that is both newest and a model change shows both markers', () => {
  const { container } = render(
    <CitationTimeline
      history={[
        { runId: 'run-1', citationState: 'cited', createdAt: '2026-07-20T12:00:00.000Z', model: 'old-model' },
        { runId: 'run-2', citationState: 'cited', createdAt: '2026-07-29T17:23:00.000Z', model: 'new-model' },
      ]}
    />,
  )

  const dots = [...container.querySelectorAll('[title]')].filter(el => el.getAttribute('title')?.includes('·'))
  const newest = dots[dots.length - 1]!
  expect(newest.getAttribute('title')).toContain('model changed')
  expect(newest.getAttribute('title')).toContain('latest run')
  // Distinct CSS properties, so neither marker suppresses the other.
  expect(newest.className).toContain('ring-caution-300/80')
  expect(newest.className).toContain('outline-mono-400')
})
