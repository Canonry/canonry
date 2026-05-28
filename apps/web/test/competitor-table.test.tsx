import { afterEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

afterEach(cleanup)

import { CompetitorTable } from '../src/components/project/CompetitorTable.js'
import type { CompetitorVm } from '../src/view-models.js'

function competitor(overrides: Partial<CompetitorVm> = {}): CompetitorVm {
  return {
    id: 'c1',
    domain: 'rival.com',
    citationCount: 3,
    totalQueries: 8,
    pressureLabel: 'Moderate',
    citedQueries: ['roofing estimate software'],
    movement: 'steady',
    notes: '',
    ...overrides,
  }
}

test('renders a remove control that reports the competitor domain', () => {
  const onRemove = vi.fn()
  render(<CompetitorTable competitors={[competitor()]} onRemoveCompetitor={onRemove} />)

  fireEvent.click(screen.getByLabelText('Remove competitor rival.com'))

  expect(onRemove).toHaveBeenCalledTimes(1)
  expect(onRemove).toHaveBeenCalledWith('rival.com')
})

test('remove click does not also trigger the row filter (stops propagation)', () => {
  const onRemove = vi.fn()
  const onSelect = vi.fn()
  render(
    <CompetitorTable
      competitors={[competitor()]}
      onRemoveCompetitor={onRemove}
      onSelectCompetitor={onSelect}
    />,
  )

  fireEvent.click(screen.getByLabelText('Remove competitor rival.com'))

  expect(onRemove).toHaveBeenCalledWith('rival.com')
  expect(onSelect).not.toHaveBeenCalled()
})

test('omits the remove control when no remove handler is provided', () => {
  render(<CompetitorTable competitors={[competitor()]} onSelectCompetitor={vi.fn()} />)

  expect(screen.queryByLabelText('Remove competitor rival.com')).toBeNull()
})
