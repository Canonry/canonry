// Sweep times read in New York, as the approved mockups are drawn.
process.env.TZ = 'America/New_York'

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

const openRun = vi.fn()
vi.mock('../src/hooks/use-drawer.js', () => ({ useDrawer: () => ({ openRun }) }))

import { formatDuration, toRunListItem } from '../src/build-dashboard.js'
import { PastSweeps } from '../src/components/project/PastSweeps.js'
import { ainycRuns } from './ainyc-visibility-fixture.js'

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-29T14:00:00.000Z'))
})
afterAll(() => { vi.useRealTimers() })
afterEach(() => {
  cleanup()
  openRun.mockReset()
})

function rows() {
  return [...screen.getByRole('table', { name: 'Past sweeps' }).querySelectorAll('tbody tr')]
    .map(row => [...row.children].map(cell => cell.textContent ?? ''))
}

describe('run list items', () => {
  test('ainyc\'s sweeps read as the approved Past sweeps lines', () => {
    expect(ainycRuns().map(run => toRunListItem(run, 'ainyc')).map(item => [item.startedAt, item.triggerLabel, item.duration])).toEqual([
      ['Sep 29, 5:59 AM', 'Manual', '2 minutes 28 seconds'],
      ['Sep 29, 5:41 AM', 'Manual', '2 minutes 10 seconds'],
      // 233.956 seconds rounds down.
      ['Jul 14, 2:00 AM', 'Scheduled', '3 minutes 53 seconds'],
      ['May 28, 4:30 PM', 'Manual', '3 minutes 54 seconds'],
      ['May 16, 10:28 PM', 'Spot check', '5 seconds'],
    ])
  })

  test('a sweep outside the current year carries its year', () => {
    const [run] = ainycRuns()
    expect(toRunListItem({ ...run!, startedAt: '2025-09-29T09:59:38.446Z' }, 'ainyc').startedAt).toBe('Sep 29, 2025, 5:59 AM')
  })

  test.each([
    [null, null, 'Waiting'],
    ['2026-09-29T10:00:00.000Z', null, 'Running'],
    ['2026-09-29T10:00:00.000Z', '2026-09-29T10:00:00.400Z', 'under 1 second'],
    ['2026-09-29T10:00:00.000Z', '2026-09-29T10:00:01.000Z', '1 second'],
    ['2026-09-29T10:00:00.000Z', '2026-09-29T10:01:00.000Z', '1 minute'],
    ['2026-09-29T10:00:00.000Z', '2026-09-29T10:01:01.000Z', '1 minute 1 second'],
    ['2026-09-29T10:00:00.000Z', '2026-09-29T11:05:30.000Z', '1 hour 5 minutes'],
    ['2026-09-29T10:00:00.000Z', '2026-09-29T12:00:59.000Z', '2 hours'],
  ])('a run from %s to %s lasts "%s"', (startedAt, finishedAt, words) => {
    expect(formatDuration(startedAt, finishedAt)).toBe(words)
  })
})

describe('PastSweeps', () => {
  test('one line per sweep, the spot check labelled and the time opening its run', () => {
    render(<PastSweeps runs={ainycRuns().map(run => toRunListItem(run, 'ainyc'))} />)

    expect(screen.getByRole('heading', { name: 'Past sweeps' })).toBeTruthy()
    expect(rows()).toEqual([
      ['Sep 29, 5:59 AM', 'Manual', '2 minutes 28 seconds', ''],
      ['Sep 29, 5:41 AM', 'Manual', '2 minutes 10 seconds', ''],
      ['Jul 14, 2:00 AM', 'Scheduled', '3 minutes 53 seconds', ''],
      ['May 28, 4:30 PM', 'Manual', '3 minutes 54 seconds', ''],
      ['May 16, 10:28 PM', 'Spot check', '5 seconds', ''],
    ])

    fireEvent.click(screen.getByRole('button', { name: 'View the Jul 14, 2:00 AM sweep' }))
    expect(openRun).toHaveBeenCalledWith('8891101e-7224-4843-8912-5c88d2579095')
  })

  test('keeps the error detail on a partial or failed sweep', () => {
    const [latest, previous, older] = ainycRuns()
    const runs = [
      toRunListItem({ ...latest!, status: 'partial', error: { message: 'claude: credit balance too low' } }, 'ainyc'),
      toRunListItem({ ...previous!, status: 'failed', error: null }, 'ainyc'),
      toRunListItem({ ...older!, status: 'cancelled' }, 'ainyc'),
    ]
    render(<PastSweeps runs={runs} />)

    const [partial, failed, cancelled] = rows()
    expect(partial![3]).toMatch(/^partial.*credit balance too low/)
    expect(failed![3]).toBe('failedRun failed.')
    // A cancelled sweep says so, with no error detail to repeat.
    expect(cancelled![3]).toBe('cancelled')
  })

  test('adds a location column only when the sweeps span locations', () => {
    const [latest, previous] = ainycRuns()
    render(<PastSweeps runs={[toRunListItem(latest!, 'ainyc'), toRunListItem({ ...previous!, location: 'brooklyn' }, 'ainyc')]} />)

    const table = screen.getByRole('table', { name: 'Past sweeps' })
    expect(within(table).getAllByRole('columnheader').map(cell => cell.textContent)).toEqual(['Started', 'Trigger', 'Location', 'Duration', 'Status'])
    expect(rows().map(row => row[2])).toEqual(['nyc', 'brooklyn'])
  })
})
