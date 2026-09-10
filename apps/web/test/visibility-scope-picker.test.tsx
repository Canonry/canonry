import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { VisibilityReportScopeOption } from '@ainyc/canonry-contracts'
import { VisibilityScopePicker, MARKET_SCOPE_COPY } from '../src/components/project/VisibilityScopePicker.js'

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
    expect(screen.getByText('Subgroups (2)').closest('details')!.open).toBe(true)
    expect(screen.getByText('All properties (2)').closest('details')!.open).toBe(false)
    expect(screen.getByRole('button', { name: 'Select Harbor House' }).closest('details')!.open).toBe(false)
    fireEvent.click(screen.getByText('All properties (2)'))
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
    expect(screen.getByRole('button', { name: 'Select Harbor House' }).closest('details')!.open).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Browse City Center' }))
    expect(screen.queryByRole('button', { name: 'Select Lake House' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Select Harbor House' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to North Region' }))
    expect(screen.getByRole('button', { name: 'Select Lake House' }).closest('details')!.open).toBe(false)
    fireEvent.click(screen.getByText('All properties (2)'))
    expect(screen.getAllByRole('button', { name: 'Select Harbor House' })).toHaveLength(1)
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

  it('lists group members by display name regardless of stable-key order', () => {
    openPicker(vi.fn(), [...scopes].reverse())
    fireEvent.click(screen.getByRole('button', { name: 'Browse North Region' }))
    fireEvent.click(screen.getByText('All properties (2)'))
    expect(screen.getAllByRole('button', { name: /^Select .* House$/ }).map(button => button.getAttribute('aria-label'))).toEqual(['Select Harbor House', 'Select Lake House'])
  })

  it('lets both hierarchy sections collapse independently without changing the selected scope', () => {
    const { onSelect } = openPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Browse North Region' }))
    fireEvent.click(screen.getByText('Subgroups (2)'))
    expect(screen.getByRole('button', { name: 'Select City Center' }).closest('details')!.open).toBe(false)
    fireEvent.click(screen.getByText('All properties (2)'))
    expect(screen.getByRole('button', { name: 'Select Harbor House' })).toBeTruthy()
    fireEvent.click(screen.getByText('All properties (2)'))
    expect(screen.getByRole('button', { name: 'Select Harbor House' }).closest('details')!.open).toBe(false)
    expect(screen.getByRole('button', { name: 'Select North Region' })).toBeTruthy()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('shows leaf properties in a collapsible list and exposes search matches even after collapse', () => {
    openPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Browse North Region' }))
    fireEvent.click(screen.getByRole('button', { name: 'Browse City Center' }))
    expect(screen.getByText('Properties (1)').closest('details')!.open).toBe(true)
    fireEvent.click(screen.getByText('Properties (1)'))
    expect(screen.getByRole('button', { name: 'Select Harbor House' }).closest('details')!.open).toBe(false)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search scopes' }), { target: { value: 'Harbor' } })
    expect(screen.getByRole('button', { name: 'Select Harbor House' })).toBeTruthy()
  })

  it('reopens at the selected subgroup with its explicit parent available', () => {
    const onSelect = vi.fn()
    const view = openPicker(onSelect)
    fireEvent.click(screen.getByRole('button', { name: 'Browse North Region' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select City Center' }))
    view.rerender(<VisibilityScopePicker options={scopes} selected={scopes[3]!} onSelect={onSelect} />)
    fireEvent.click(view.container.querySelector('summary')!)
    expect(screen.getByRole('button', { name: 'Back to North Region' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Select Harbor House' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Select Lake House' })).toBeNull()
  })

  it('opens a selected property at its deepest declared group and preserves an overlapping membership', () => {
    const onSelect = vi.fn()
    const view = render(<VisibilityScopePicker options={scopes} selected={scopes[5]!} onSelect={onSelect} />)
    const trigger = view.container.querySelector('summary')!
    fireEvent.click(trigger)
    expect(screen.getByRole('button', { name: 'Select City Center' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to North Region' }))
    fireEvent.click(screen.getByRole('button', { name: 'Browse Waterfront' }))
    fireEvent.click(screen.getByRole('button', { name: 'Select Harbor House' }))
    fireEvent.click(trigger)
    expect(screen.getByRole('button', { name: 'Select Waterfront' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Select Harbor House' }).getAttribute('aria-current')).toBe('true')
  })

  it('keeps a selected property with unavailable parent metadata reachable', () => {
    const selected = { ...scopes[5]!, parentGroupIds: ['retired'] }
    const view = render(<VisibilityScopePicker options={[...scopes.filter(scope => scope.id !== selected.id), selected]} selected={selected} onSelect={vi.fn()} />)
    fireEvent.click(view.container.querySelector('summary')!)
    expect(screen.getByText('All properties', { selector: 'p' })).toBeTruthy()
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


describe('market context through property navigation', () => {
  const marketScopes: VisibilityReportScopeOption[] = scopes.map(scope => ({
    ...scope,
    ...(['center', 'waterfront'].includes(scope.id) ? { marketKeys: [`market-${scope.id}`] } : scope.id === 'a' ? { marketKeys: ['market-center', 'market-waterfront'] } : {}),
  })).concat(['center', 'waterfront'].map(id => ({ id: `market-${id}`, label: `${id} questions`, kind: 'market' as const, targetCount: 1, parentGroupIds: [id] })))
  const property = marketScopes.find(scope => scope.id === 'a')!
  const region = marketScopes.find(scope => scope.id === 'north')!

  it.each(['center', 'waterfront'])('keeps %s when selecting a shared property and reopening from its URL', id => {
    const group = marketScopes.find(scope => scope.id === id)!
    const view = openPicker(vi.fn(), marketScopes)
    fireEvent.click(screen.getByRole('button', { name: MARKET_SCOPE_COPY.browse(region.label) }))
    fireEvent.click(screen.getByRole('button', { name: MARKET_SCOPE_COPY.browse(group.label) }))
    fireEvent.click(screen.getByRole('button', { name: MARKET_SCOPE_COPY.select(property.label) }))
    expect(view.onSelect).toHaveBeenLastCalledWith(property, `market-${id}`)
    view.unmount()
    const restored = render(<VisibilityScopePicker options={marketScopes} selected={property} marketKey={`market-${id}`} onSelect={view.onSelect} />)
    fireEvent.click(restored.container.querySelector('summary')!)
    expect(screen.getByRole('button', { name: MARKET_SCOPE_COPY.select(group.label) })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: MARKET_SCOPE_COPY.select(property.label) }))
    expect(view.onSelect).toHaveBeenLastCalledWith(property, `market-${id}`)
  })

  it('limits property choices to the linked market when it covers only part of a group', () => {
    const group = marketScopes.find(scope => scope.id === 'center')!
    const sibling = { ...marketScopes.find(scope => scope.id === 'b')!, parentGroupIds: [region.id, group.id] }
    const options = marketScopes.map(scope => scope.id === sibling.id ? sibling : scope.id === group.id ? { ...group, targetCount: 2 } : scope)
    openPicker(vi.fn(), options)
    fireEvent.click(screen.getByRole('button', { name: MARKET_SCOPE_COPY.browse(region.label) }))
    fireEvent.click(screen.getByRole('button', { name: MARKET_SCOPE_COPY.browse(group.label) }))
    expect(screen.getByRole('button', { name: MARKET_SCOPE_COPY.select(property.label) })).toBeTruthy()
    expect(screen.queryByRole('button', { name: MARKET_SCOPE_COPY.select(sibling.label) })).toBeNull()
  })

  it('selects the exact question market for a group', () => {
    const group = marketScopes.find(scope => scope.id === 'center')!
    const view = openPicker(vi.fn(), marketScopes)
    fireEvent.click(screen.getByRole('button', { name: MARKET_SCOPE_COPY.browse(region.label) }))
    fireEvent.click(screen.getByRole('button', { name: MARKET_SCOPE_COPY.select(group.label) }))
    expect(view.onSelect).toHaveBeenLastCalledWith(group, group.marketKeys![0])
  })

  it('opens a direct property selection across all its markets and clears a previous market', () => {
    const onSelect = vi.fn()
    const view = render(<VisibilityScopePicker options={marketScopes} selected={property} onSelect={onSelect} />)
    expect(view.container.querySelector('summary')!.textContent).toContain(MARKET_SCOPE_COPY.allMarkets)
    fireEvent.click(view.container.querySelector('summary')!)
    expect(screen.queryByRole('button', { name: MARKET_SCOPE_COPY.select(marketScopes.find(scope => scope.id === 'center')!.label) })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: MARKET_SCOPE_COPY.select(property.label) }))
    expect(onSelect).toHaveBeenCalledWith(property)
  })
})
