import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'

import { CitationTimeline } from '../src/components/project/CitationTimeline.js'

afterEach(cleanup)

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
  expect(timeline.getAttribute('aria-label')).toContain('not-cited')
  expect(timeline.getAttribute('aria-label')).toContain('lost')
  expect(container.querySelector('.rounded-full')).not.toBeNull()
  expect(container.querySelector('.rounded-sm')).not.toBeNull()
  expect(container.querySelector('.rotate-45')).not.toBeNull()
})
