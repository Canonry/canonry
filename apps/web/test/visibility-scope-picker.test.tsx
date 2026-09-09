import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { VisibilityReportScopeOption } from '@ainyc/canonry-contracts'
import { VisibilityScopePicker } from '../src/components/project/VisibilityScopePicker.js'

afterEach(cleanup)

const scopes: VisibilityReportScopeOption[] = [
  { id: 'project', kind: 'project', label: 'Whole site', targetCount: 3 },
  { id: 'north', kind: 'group', label: 'North Region', targetCount: 2 },
  { id: 'south', kind: 'group', label: 'South Region', targetCount: 1 },
  { id: 'center', kind: 'group', label: 'City Center', targetCount: 1, parentGroupIds: ['north'] },
  { id: 'waterfront', kind: 'group', label: 'Waterfront', targetCount: 1, parentGroupIds: ['north'] },
  { id: 'a', kind: 'property', label: 'Harbor House', targetCount: 1, parentGroupIds: ['north', 'center', 'waterfront'] },
  { id: 'b', kind: 'property', label: 'Lake House', targetCount: 1, parentGroupIds: ['north'] },
  { id: 'c', kind: 'property', label: 'Garden House', targetCount: 1, parentGroupIds: ['south'] },
  { id: 'context', kind: 'market', label: 'Remote searches', targetCount: 2 },
]

function openPicker(onSelect = vi.fn(), options = scopes) {
  const view = render(<VisibilityScopePicker options={options} selected={options[0]!} onSelect={onSelect} />)
  fireEvent.click(view.container.querySelector('summary')!)
  return { ...view, onSelect }
}

describe('group-first scope navigation', () => {
  it('starts with top-level groups and hides child groups and properties until browsing', () => {
    const { onSelect } = openPicker()
    expect(screen.getByRole('button', { name: 'Select North Region' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Select South Region' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Select City Center' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Select Harbor House' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Browse North Region' }))
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByText('Subgroups (2)').closest('details')!.open).toBe(false)
    fireEvent.click(screen.getByText('Subgroups (2)'))
    expect(screen.getByRole('button', { name: 'Select City Center' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Select Harbor House' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Select Lake House' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Select Garden House' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Select North Region' }))
    expect(onSelect).toHaveBeenCalledWith(scopes[1])
  })

  it('drills into a subgroup without duplicating overlapping properties and returns to its parent', () => {
    const { onSelect } = openPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Browse North Region' }))
    expect(screen.getAllByRole('button', { name: 'Select Harbor House' })).toHaveLength(1)
    fireEvent.click(screen.getByText('Subgroups (2)'))
    fireEvent.click(screen.getByRole('button', { name: 'Browse City Center' }))
    expect(screen.queryByRole('button', { name: 'Select Lake House' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Select Harbor House' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to North Region' }))
    expect(screen.getByRole('button', { name: 'Select Lake House' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Select Lake House' }))
    expect(onSelect).toHaveBeenCalledWith(scopes[6])
  })

  it('searches all levels from the root and only group members when browsing', () => {
    openPicker()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search scopes' }), { target: { value: 'Harbor' } })
    expect(screen.getByRole('button', { name: 'Select Harbor House' }).textContent).toContain('North Region')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search scopes' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Browse South Region' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search scopes' }), { target: { value: 'Harbor' } })
    expect(screen.queryByRole('button', { name: 'Select Harbor House' })).toBeNull()
    expect(screen.getByText('No matching scopes.')).toBeTruthy()
  })

  it('keeps group membership independent of query-context markets', () => {
    const { onSelect } = openPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Select Remote searches' }))
    expect(onSelect).toHaveBeenCalledWith(scopes[8])
  })

  it('keeps ungrouped and legacy properties reachable without inventing membership', () => {
    const legacy = scopes.filter(scope => !['center', 'waterfront'].includes(scope.id)).map(({ parentGroupIds: _, ...scope }) => scope)
    openPicker(vi.fn(), legacy)
    expect(screen.getByRole('button', { name: 'Select North Region' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Select Harbor House' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Browse all properties' }))
    expect(screen.getByRole('button', { name: 'Select Harbor House' })).toBeTruthy()
  })

  it('closes on Escape and restores focus to the scope trigger', () => {
    const view = openPicker()
    const search = screen.getByRole('searchbox', { name: 'Search scopes' })
    search.focus()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(view.container.querySelector('details')!.open).toBe(false)
    expect(document.activeElement).toBe(view.container.querySelector('summary'))
  })
})
