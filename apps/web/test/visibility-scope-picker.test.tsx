import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { VisibilityReportScopeOption } from '@ainyc/canonry-contracts'
import { VisibilityScopePicker, MARKET_SCOPE_COPY } from '../src/components/project/VisibilityScopePicker.js'

afterEach(cleanup)

const scopes: VisibilityReportScopeOption[] = [
  { id: 'project', kind: 'project', label: 'Project', targetCount: 3 },
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
    expect(screen.getByText('All locations (2)').closest('details')!.open).toBe(false)
    expect(screen.getByRole('button', { name: 'Select Harbor House' }).closest('details')!.open).toBe(false)
    fireEvent.click(screen.getByText('All locations (2)'))
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
    fireEvent.click(screen.getByText('All locations (2)'))
    expect(screen.getAllByRole('button', { name: 'Select Harbor House' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Select Lake House' }))
    expect(onSelect).toHaveBeenCalledWith(scopes[6])
  })

  it('searches all levels from the root and only group members when browsing', () => {
    openPicker()
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search places' }), { target: { value: 'Harbor' } })
    expect(screen.getByRole('button', { name: 'Select Harbor House' }).textContent).toContain('North Region')
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search places' }), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Browse South Region' }))
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search places' }), { target: { value: 'Harbor' } })
    expect(screen.queryByRole('button', { name: 'Select Harbor House' })).toBeNull()
    expect(screen.getByText('No matches')).toBeTruthy()
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
    fireEvent.click(screen.getByRole('button', { name: 'Browse all locations' }))
    expect(screen.getByRole('button', { name: 'Select Harbor House' })).toBeTruthy()
  })

  it('lists group members by display name regardless of stable-key order', () => {
    openPicker(vi.fn(), [...scopes].reverse())
    fireEvent.click(screen.getByRole('button', { name: 'Browse North Region' }))
    fireEvent.click(screen.getByText('All locations (2)'))
    expect(screen.getAllByRole('button', { name: /^Select .* House$/ }).map(button => button.getAttribute('aria-label'))).toEqual(['Select Harbor House', 'Select Lake House'])
  })

  it('lets both hierarchy sections collapse independently without changing the selected scope', () => {
    const { onSelect } = openPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Browse North Region' }))
    fireEvent.click(screen.getByText('Subgroups (2)'))
    expect(screen.getByRole('button', { name: 'Select City Center' }).closest('details')!.open).toBe(false)
    fireEvent.click(screen.getByText('All locations (2)'))
    expect(screen.getByRole('button', { name: 'Select Harbor House' })).toBeTruthy()
    fireEvent.click(screen.getByText('All locations (2)'))
    expect(screen.getByRole('button', { name: 'Select Harbor House' }).closest('details')!.open).toBe(false)
    expect(screen.getByRole('button', { name: 'Select North Region' })).toBeTruthy()
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('shows leaf properties in a collapsible list and exposes search matches even after collapse', () => {
    openPicker()
    fireEvent.click(screen.getByRole('button', { name: 'Browse North Region' }))
    fireEvent.click(screen.getByRole('button', { name: 'Browse City Center' }))
    expect(screen.getByText('Locations (1)').closest('details')!.open).toBe(true)
    fireEvent.click(screen.getByText('Locations (1)'))
    expect(screen.getByRole('button', { name: 'Select Harbor House' }).closest('details')!.open).toBe(false)
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search places' }), { target: { value: 'Harbor' } })
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
    expect(screen.getByText('All locations', { selector: 'p' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Select Harbor House' })).toBeTruthy()
  })

  it('closes on Escape and restores focus to the scope trigger', () => {
    const view = openPicker()
    const search = screen.getByRole('searchbox', { name: 'Search places' })
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

  it('keeps a group selection free of an implicit market filter', () => {
    const group = marketScopes.find(scope => scope.id === 'center')!
    const view = openPicker(vi.fn(), marketScopes)
    fireEvent.click(screen.getByRole('button', { name: MARKET_SCOPE_COPY.browse(region.label) }))
    fireEvent.click(screen.getByRole('button', { name: MARKET_SCOPE_COPY.select(group.label) }))
    expect(view.onSelect).toHaveBeenLastCalledWith(group)
  })

  it.each(['market', 'property', 'group'] as const)('retains an explicit market from a %s selection within a group containing multiple markets', kind => {
    const group = { ...marketScopes.find(scope => scope.id === 'center')!, marketKeys: property.marketKeys }
    const market = { ...marketScopes.find(scope => scope.id === 'market-waterfront')!, parentGroupIds: [group.id] }
    const options = marketScopes.map(scope => scope.id === group.id ? group : scope.id === market.id ? market : scope)
    const onSelect = vi.fn()
    const view = render(<VisibilityScopePicker options={options} selected={kind === 'market' ? market : kind === 'group' ? group : property} marketKey={kind === 'market' ? undefined : market.id} onSelect={onSelect} />)
    fireEvent.click(view.container.querySelector('summary')!)
    fireEvent.click(screen.getByRole('button', { name: MARKET_SCOPE_COPY.select(property.label) }))
    expect(onSelect).toHaveBeenCalledWith(property, market.id)
  })

  it.each(['root', 'region', 'group'])('finds nested markets by their exact name from the %s', level => {
    const market = marketScopes.find(scope => scope.id === 'market-center')!
    const view = openPicker(vi.fn(), marketScopes)
    if (level !== 'root') fireEvent.click(screen.getByRole('button', { name: MARKET_SCOPE_COPY.browse(region.label) }))
    if (level === 'group') fireEvent.click(screen.getByRole('button', { name: MARKET_SCOPE_COPY.browse(marketScopes.find(scope => scope.id === market.parentGroupIds![0])!.label) }))
    expect(screen.queryByRole('button', { name: MARKET_SCOPE_COPY.select(market.label) })).toBeNull()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: market.label } })
    fireEvent.click(screen.getByRole('button', { name: MARKET_SCOPE_COPY.select(market.label) }))
    expect(view.onSelect).toHaveBeenCalledWith(market)
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

  it('writes a single-market Group\'s market for a Property chosen inside it, but not for the Group itself', () => {
    const options: VisibilityReportScopeOption[] = [
      { id: 'project', kind: 'project', label: 'Project', targetCount: 2 },
      { id: 'coastal', kind: 'group', label: 'Coastal Maine', targetCount: 2, marketKeys: ['coastal-market'] },
      { id: 'coastal-market', kind: 'market', label: 'Coastal Maine', targetCount: 2, parentGroupIds: ['coastal'] },
      { id: 'harbor', kind: 'property', label: 'Harbor House', targetCount: 1, parentGroupIds: ['coastal'], marketKeys: ['coastal-market'] },
      { id: 'dune', kind: 'property', label: 'Dune Inn', targetCount: 1, parentGroupIds: ['coastal'], marketKeys: ['coastal-market'] },
    ]
    const [project, group, , harbor] = options
    const onSelect = vi.fn()
    const view = render(<VisibilityScopePicker options={options} selected={project!} onSelect={onSelect} />)
    const trigger = view.container.querySelector('summary')!

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: MARKET_SCOPE_COPY.browse('Coastal Maine') }))
    fireEvent.click(screen.getByRole('button', { name: MARKET_SCOPE_COPY.select('Harbor House') }))
    expect(onSelect.mock.lastCall).toStrictEqual([harbor, 'coastal-market'])

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: MARKET_SCOPE_COPY.browse('Coastal Maine') }))
    fireEvent.click(within(screen.getByText('All in this group').closest('button')!.parentElement!).getByRole('button', { name: MARKET_SCOPE_COPY.select('Coastal Maine') }))
    expect(onSelect.mock.lastCall).toStrictEqual([group])

    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('button', { name: MARKET_SCOPE_COPY.select('Coastal Maine') }))
    expect(onSelect.mock.lastCall).toStrictEqual([group])
    expect(onSelect).toHaveBeenCalledTimes(3)
  })
})

describe('trigger label and naming', () => {
  it.each([
    ['group with one location', { id: 'metro-beta', kind: 'group', label: 'Metro Beta', targetCount: 1 }, 'Metro Beta · 1 location'],
    ['group', { id: 'metro-beta', kind: 'group', label: 'Metro Beta', targetCount: 15 }, 'Metro Beta · 15 locations'],
    // Thousands are grouped, as in the counts beside the picker.
    ['large group', { id: 'metro-beta', kind: 'group', label: 'Metro Beta', targetCount: 1240 }, 'Metro Beta · 1,240 locations'],
    ['market', { id: 'metro-beta', kind: 'market', label: 'Metro Beta', targetCount: 15 }, 'Metro Beta · Market'],
  ] as const)('names a selected %s by label and kind', (_name, selected, text) => {
    render(<VisibilityScopePicker options={[scopes[0]!, selected]} selected={selected} onSelect={vi.fn()} />)
    expect(screen.getByText(text, { selector: 'summary' })).toBeTruthy()
  })

  it.each([
    ['the default noun', undefined, 'location', 'Location'],
    ['a supplied noun', ['store', 'stores'], 'store', 'Store'],
  ] as const)('calls a location by %s in every label, count and placeholder', (_name, propertyNoun, noun, Noun) => {
    const view = render(<VisibilityScopePicker options={scopes} selected={scopes[6]!} propertyNoun={propertyNoun} onSelect={vi.fn()} />)
    const trigger = view.container.querySelector('summary')!
    expect(trigger.textContent).toBe(`Lake House · ${Noun}`)
    // Opens inside Lake House's group.
    fireEvent.click(trigger)
    // The group's own row is four words; the count beside it carries the noun.
    expect(screen.getByText('All in this group').closest('button')!.textContent).toBe(`All in this group2 ${noun}s`)
    expect(screen.getByText(`All ${noun}s (2)`)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Select Lake House' }).textContent).toBe(`Lake House${Noun}`)
    fireEvent.click(screen.getByRole('button', { name: 'Back to all groups' }))
    expect(screen.getByPlaceholderText(`Search groups or ${noun}s`)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Select South Region' }).textContent).toBe(`South Region1 ${noun}`)
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'House' } })
    expect(screen.getByRole('region', { name: `${Noun}s` })).toBeTruthy()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: `Browse all ${noun}s` }))
    expect(screen.getByPlaceholderText(`Search ${noun}s`)).toBeTruthy()
    expect(screen.getByText(`All ${noun}s`, { selector: 'p' })).toBeTruthy()
    expect(screen.getByText(`${Noun}s (3)`)).toBeTruthy()
    expect(view.container.textContent).not.toMatch(/propert/i)
  })

  it('names the project option All locations, or the root label the caller supplies', () => {
    // The server labels the option "Project"; the picker never shows that label.
    const byDefault = openPicker()
    expect(byDefault.container.querySelector('summary')!.textContent).toBe(MARKET_SCOPE_COPY.allLocations)
    expect(screen.getByRole('button', { name: 'Select All locations' }).textContent).toBe('All locations3 locations')
    expect(byDefault.container.textContent).not.toContain('Project')
    byDefault.unmount()

    const onSelect = vi.fn()
    const named = render(<VisibilityScopePicker options={scopes} selected={scopes[1]!} rootLabel="All of Citypoint" onSelect={onSelect} />)
    fireEvent.click(named.container.querySelector('summary')!)
    fireEvent.click(screen.getByRole('button', { name: 'Back to all groups' }))
    // Search matches the root label, not the server's label.
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search places' }), { target: { value: 'citypoint' } })
    fireEvent.click(screen.getByRole('button', { name: 'Select All of Citypoint' }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(scopes[0])
    named.rerender(<VisibilityScopePicker options={scopes} selected={scopes[0]!} rootLabel="All of Citypoint" onSelect={onSelect} />)
    expect(named.container.querySelector('summary')!.textContent).toBe('All of Citypoint')
  })

  it.each(['visible', 'sr-only'] as const)('keeps a %s label naming the trigger and returns focus when search closes', labelVisibility => {
    const view = render(<VisibilityScopePicker options={scopes} selected={scopes[0]!} onSelect={vi.fn()} labelVisibility={labelVisibility} />)
    const label = screen.getByText('Place')
    const trigger = screen.getByText('All locations', { selector: 'summary' })
    expect(label.id).not.toBe('')
    expect(trigger.getAttribute('aria-labelledby')).toBe(`${label.id} ${trigger.id}`)
    expect(label.className).toBe(labelVisibility === 'sr-only' ? 'sr-only' : 'mb-1 block text-sm font-medium text-heading')
    const picker = trigger.closest('details')!
    picker.open = true
    const search = screen.getByRole('searchbox', { name: 'Search places' })
    search.focus()
    fireEvent.keyDown(search, { key: 'Escape' })
    expect(picker.open).toBe(false)
    expect(document.activeElement).toBe(trigger)
    view.unmount()
  })

  it('defaults to a visible label and never changes the trigger classes', () => {
    const visible = render(<VisibilityScopePicker options={scopes} selected={scopes[0]!} onSelect={vi.fn()} />)
    expect(screen.getByText('Place').className).toBe('mb-1 block text-sm font-medium text-heading')
    const visibleTriggerClass = visible.container.querySelector('summary')!.className
    visible.unmount()
    const hidden = render(<VisibilityScopePicker options={scopes} selected={scopes[0]!} onSelect={vi.fn()} labelVisibility="sr-only" />)
    expect(hidden.container.querySelector('summary')!.className).toBe(visibleTriggerClass)
    expect(visibleTriggerClass.split(' ')).toContain('visibility-scope-trigger')
  })

  it('distinguishes a group from a market with the same label', () => {
    const options: VisibilityReportScopeOption[] = [
      { id: 'project', label: 'Whole site', kind: 'project', targetCount: 15 },
      { id: 'metro-alpha', label: 'Metro Alpha', kind: 'group', targetCount: 15 },
      { id: 'market-alpha', label: 'Metro Alpha', kind: 'market', targetCount: 15 },
      { id: 'p1', label: 'Northstar One', kind: 'property', targetCount: 1 },
    ]
    render(<VisibilityScopePicker options={options} selected={options[0]!} onSelect={vi.fn()} />)
    screen.getByText('All locations', { selector: 'summary' }).closest('details')!.open = true
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search places' }), { target: { value: 'Metro Alpha' } })
    expect(within(screen.getByRole('region', { name: 'Groups', exact: true })).getByRole('button', { name: 'Select Metro Alpha', exact: true }).textContent).toContain('15 locations')
    expect(within(screen.getByRole('region', { name: 'Markets', exact: true })).getByRole('button', { name: 'Select Metro Alpha', exact: true }).textContent).toBe('Metro AlphaMarket')
  })
})

describe('an empty choice', () => {
  it('shows the placeholder until something is selected, then the selection', () => {
    const onSelect = vi.fn()
    const view = render(<VisibilityScopePicker options={scopes} placeholder="Choose a market" onSelect={onSelect} />)
    const trigger = view.container.querySelector('summary')!
    expect(trigger.textContent).toBe('Choose a market')
    expect(trigger.getAttribute('aria-labelledby')).toBe(`${screen.getByText('Place').id} ${trigger.id}`)

    fireEvent.click(trigger)
    expect(screen.getByRole('button', { name: 'Select North Region' })).toBeTruthy()
    expect(view.container.querySelector('[aria-current]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Select Remote searches' }))
    expect(onSelect).toHaveBeenCalledWith(scopes[8])

    view.rerender(<VisibilityScopePicker options={scopes} selected={scopes[8]!} placeholder="Choose a market" onSelect={onSelect} />)
    expect(trigger.textContent).toBe('Remote searches · Market')
    expect(screen.queryByText('Choose a market')).toBeNull()
  })

  it('falls back to a default placeholder', () => {
    const view = render(<VisibilityScopePicker options={scopes} onSelect={vi.fn()} />)
    expect(view.container.querySelector('summary')!.textContent).toBe('Choose a place')
  })
})

describe('browsing with group selection off', () => {
  const options: VisibilityReportScopeOption[] = [
    ...scopes,
    { id: 'north-market', kind: 'market', label: 'North searches', targetCount: 2, parentGroupIds: ['north'] },
  ]
  const openBrowseOnly = () => {
    const onSelect = vi.fn()
    const view = render(<VisibilityScopePicker options={options} placeholder="Choose a market" allowGroupSelect={false} onSelect={onSelect} />)
    fireEvent.click(view.container.querySelector('summary')!)
    return { ...view, onSelect }
  }

  it('keeps a market with no parent group reachable from the top level', () => {
    const { onSelect } = openBrowseOnly()
    const markets = within(screen.getByRole('region', { name: 'Markets', exact: true }))
    expect(markets.getAllByRole('button').map(button => button.getAttribute('aria-label'))).toEqual(['Select Remote searches'])
    expect(markets.getByRole('button', { name: 'Select Remote searches' }).textContent).toContain('Market')
    fireEvent.click(markets.getByRole('button', { name: 'Select Remote searches' }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(scopes[8])
  })

  it('keeps a grouped market inside its group', () => {
    const { onSelect } = openBrowseOnly()
    expect(screen.queryByRole('button', { name: 'Select North searches' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Browse North Region' }))
    expect(screen.queryByRole('button', { name: 'Select Remote searches' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Select North searches' }))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(options.at(-1))
  })

  it('makes a group row browse, never select', () => {
    const { onSelect, container } = openBrowseOnly()
    expect(screen.queryByRole('button', { name: 'Select North Region' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Browse North Region' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Browse North Region' }))
    expect(onSelect).not.toHaveBeenCalled()
    expect(container.querySelector('details')!.open).toBe(true)
    expect(screen.getByRole('button', { name: 'Back to all groups' })).toBeTruthy()
    expect(screen.queryByText('All in this group')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Browse City Center' }))
    expect(screen.getByRole('button', { name: 'Back to North Region' })).toBeTruthy()
    expect(onSelect).not.toHaveBeenCalled()
  })
})
