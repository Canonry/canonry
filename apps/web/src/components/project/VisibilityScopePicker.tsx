import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import type { VisibilityReportScopeOption } from '@ainyc/canonry-contracts'

const CONTROL = 'min-h-11 w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400'
const ROW = 'flex min-h-11 w-full items-center justify-between gap-3 rounded px-2 text-left text-sm text-primary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400'
const labelFor = (scope: VisibilityReportScopeOption) => scope.kind === 'project' ? 'Whole site' : scope.label
const countFor = (count: number) => `${count} ${count === 1 ? 'property' : 'properties'}`

/** Navigation uses explicit frozen memberships, never labels or inferred containment. */
export function VisibilityScopePicker({ options, selected, onSelect }: {
  options: VisibilityReportScopeOption[]
  selected: VisibilityReportScopeOption
  onSelect: (scope: VisibilityReportScopeOption) => void
}) {
  const [search, setSearch] = useState('')
  const [path, setPath] = useState<string[]>([])
  const [allProperties, setAllProperties] = useState(false)
  const picker = useRef<HTMLDetailsElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const id = useId()
  const groups = options.filter(scope => scope.kind === 'group')
  const groupById = new Map(groups.map(group => [group.id, group]))
  const current = groupById.get(path.at(-1) ?? '')
  const parent = groupById.get(path.at(-2) ?? '')
  const query = search.trim().toLocaleLowerCase()
  const roots = groups.filter(group => !group.parentGroupIds?.some(key => groupById.has(key)))
  const properties = options.filter(scope => scope.kind === 'property')
  const parentLabels = (scope: VisibilityReportScopeOption) => (scope.parentGroupIds ?? []).map(key => groupById.get(key)?.label).filter(Boolean).join(' · ')
  const matches = (scope: VisibilityReportScopeOption) => `${labelFor(scope)} ${parentLabels(scope)}`.toLocaleLowerCase().includes(query)
  const isDescendant = (scope: VisibilityReportScopeOption): boolean => {
    const pending = [...(scope.parentGroupIds ?? [])]
    const visited = new Set<string>()
    while (pending.length) {
      const key = pending.pop()!
      if (key === current?.id) return true
      if (visited.has(key)) continue
      visited.add(key)
      pending.push(...(groupById.get(key)?.parentGroupIds ?? []))
    }
    return false
  }
  const visibleGroups = (allProperties ? [] : current
    ? groups.filter(group => query ? isDescendant(group) : group.parentGroupIds?.includes(current.id))
    : query ? groups : roots).filter(matches)
  const visibleProperties = (current ? properties.filter(property => property.parentGroupIds?.includes(current.id))
    : query || allProperties || groups.length === 0 ? properties : []).filter(matches)
  const markets = current || allProperties ? [] : options.filter(scope => scope.kind === 'market' && matches(scope))
  const projects = current || allProperties ? [] : options.filter(scope => scope.kind === 'project' && matches(scope))

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (picker.current?.open && event.target instanceof Node && !picker.current.contains(event.target)) picker.current.open = false
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [])

  const choose = (scope: VisibilityReportScopeOption) => {
    if (picker.current) { picker.current.open = false; picker.current.querySelector('summary')?.focus() }
    onSelect(scope)
  }
  const browse = (scope: VisibilityReportScopeOption) => {
    // Search can jump to a nested group; reconstruct the explicit ancestry for Back.
    const ancestors: string[] = []
    let ancestor = groupById.get(scope.parentGroupIds?.[0] ?? '')
    while (ancestor && !ancestors.includes(ancestor.id) && ancestor.id !== scope.id) {
      ancestors.unshift(ancestor.id)
      ancestor = groupById.get(ancestor.parentGroupIds?.[0] ?? '')
    }
    setPath([...ancestors, scope.id]); setAllProperties(false); setSearch(''); searchInput.current?.focus()
  }
  const row = (scope: VisibilityReportScopeOption, displayLabel = labelFor(scope)) => <div key={`${scope.kind}:${scope.id}`} className="flex items-stretch">
    <button type="button" className={ROW} aria-label={`Select ${labelFor(scope)}`} aria-current={selected.kind === scope.kind && selected.id === scope.id ? 'true' : undefined} onClick={() => choose(scope)}>
      <span className="min-w-0 break-words">{displayLabel}{query && parentLabels(scope) ? <span className="block text-[13px] text-secondary">{parentLabels(scope)}</span> : null}</span>
      <span className="shrink-0 text-right text-[13px] text-secondary">{scope.kind === 'market' ? 'Query context' : scope.kind === 'property' ? 'Property' : countFor(scope.targetCount)}</span>
    </button>
    {scope.kind === 'group' && scope.id !== current?.id && options.some(option => option.parentGroupIds?.includes(scope.id)) ? <button type="button" aria-label={`Browse ${scope.label}`} title={`Browse ${scope.label}`} className="flex min-h-11 min-w-11 items-center justify-center rounded text-secondary hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-mono-400" onClick={() => browse(scope)}><ChevronRight size={18} aria-hidden="true" /></button> : null}
  </div>
  const section = (label: string, scopes: VisibilityReportScopeOption[]) => scopes.length > 0 ? <section aria-label={label} className="mt-2">
    <h3 className="px-2 py-2 text-[13px] font-medium text-secondary">{label}</h3>{scopes.map(scope => row(scope))}
  </section> : null

  return <div className="min-w-0">
    <span id={`${id}-label`} className="mb-1 block text-sm font-medium text-heading">Measurement scope</span>
    <details ref={picker} className="relative" onToggle={event => {
      if (event.target === event.currentTarget && event.currentTarget.open) { setSearch(''); setPath([]); setAllProperties(false); searchInput.current?.focus() }
    }} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus() }
    }}>
      <summary id={`${id}-value`} aria-labelledby={`${id}-label ${id}-value`} className={`${CONTROL} visibility-scope-trigger`}>
        {`${labelFor(selected)}${selected.kind === 'group' ? ` · ${countFor(selected.targetCount)}` : selected.kind === 'property' ? ' · Property' : selected.kind === 'market' ? ' · Market' : ''}`}<ChevronDown size={16} aria-hidden="true" className="shrink-0 text-secondary" />
      </summary>
      <div className="visibility-scope-menu">
        {current || allProperties ? <div className="mb-2 border-b border-default pb-2">
          <button type="button" className={ROW} aria-label={`Back to ${parent?.label ?? 'all groups'}`} onClick={() => { setPath(path.slice(0, -1)); setAllProperties(false); setSearch(''); searchInput.current?.focus() }}><span className="flex items-center gap-1"><ChevronLeft size={16} aria-hidden="true" />{parent?.label ?? 'All groups'}</span></button>
          <p className="px-2 py-1 text-sm font-medium text-heading" aria-live="polite">{current?.label ?? 'All properties'}</p>
        </div> : null}
        <input ref={searchInput} type="search" aria-label="Search scopes" className={CONTROL} placeholder={current ? 'Search within this group' : allProperties ? 'Search properties' : 'Search groups or properties'} value={search} onChange={event => setSearch(event.target.value)} />
        <div className="mt-2 max-h-80 overflow-y-auto">
          {current && !query ? row(current, 'All properties in this group') : null}
          {projects.map(scope => row(scope))}
          {current && !query && visibleGroups.length > 0 ? <details key={current.id} className="mt-2 border-y border-default">
            <summary className="min-h-11 cursor-pointer px-2 py-3 text-sm text-primary">Subgroups ({visibleGroups.length})</summary>
            {visibleGroups.map(scope => row(scope))}
          </details> : section(current ? 'Subgroups' : 'Groups', visibleGroups)}
          {section('Properties', visibleProperties)}
          {section('Markets', markets)}
          {!current && !allProperties && !query && groups.length > 0 && properties.length > 0 ? <button type="button" className={`${ROW} mt-2 border-t border-default`} aria-label="Browse all properties" onClick={() => { setAllProperties(true); searchInput.current?.focus() }}><span>All properties</span><ChevronRight size={18} aria-hidden="true" /></button> : null}
          {query && visibleGroups.length + visibleProperties.length + markets.length + projects.length === 0 ? <p className="py-3 text-sm text-secondary">No matching scopes.</p> : null}
        </div>
      </div>
    </details>
  </div>
}
