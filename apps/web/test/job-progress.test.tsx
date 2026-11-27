import { afterEach, expect, test } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

import { JobProgress } from '../src/components/shared/JobProgress.js'

afterEach(cleanup)

test('the first answer mounts a fresh fill at its share, never shrinking the full-width pulse into it', () => {
  const progress = (done: number) => <JobProgress label="Check progress" noun="check" phase="Asking engines" done={done} total={5} />
  const { rerender } = render(progress(0))
  const bar = screen.getByRole('progressbar', { name: 'Check progress' })
  const pulse = bar.firstElementChild
  expect(pulse?.className).toContain('animate-pulse')

  rerender(progress(2))
  // A new element has no earlier width to animate from, so it starts at 40%
  // rather than sliding down from the pulse's 100%.
  const fill = bar.firstElementChild as HTMLElement
  expect(fill).not.toBe(pulse)
  expect(fill.style.width).toBe('40%')

  // Later answers grow that same fill.
  rerender(progress(4))
  expect(bar.firstElementChild).toBe(fill)
  expect(fill.style.width).toBe('80%')
})
