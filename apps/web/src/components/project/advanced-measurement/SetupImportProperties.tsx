import { useEffect, useId, useRef, useState } from 'react'
import { Button } from '../../ui/button.js'
import { ToneBadge } from '../../shared/ToneBadge.js'
import { InfoTooltip } from '../../shared/InfoTooltip.js'

export type AdvancedMeasurementSetupStep = 'import' | 'properties'
export type AdvancedMeasurementReviewState = 'idle' | 'reviewing' | 'error'
export type AdvancedMeasurementPropertiesState = 'ready' | 'loading' | 'error'
export type AdvancedMeasurementPropertyState = 'proposed' | 'confirmed' | 'excluded'

export interface AdvancedMeasurementImportDraft {
  sitemapUrl: string
  examplePropertyUrl: string
  preferredHost: string
  propertyPathPattern: string
  additionalHost: string
  additionalPathPattern: string
  excludedPaths: string
}

export interface AdvancedMeasurementProperty {
  id: string
  name: string
  url: string
  urls?: readonly string[]
  state: AdvancedMeasurementPropertyState
}

export interface AdvancedMeasurementImportPropertiesProps {
  activeStep: AdvancedMeasurementSetupStep
  canEdit: boolean
  importDraft: AdvancedMeasurementImportDraft
  onImportDraftChange: (next: AdvancedMeasurementImportDraft) => void
  onReviewSitemap: (draft: AdvancedMeasurementImportDraft) => void
  reviewState: AdvancedMeasurementReviewState
  properties: readonly AdvancedMeasurementProperty[]
  propertiesState: AdvancedMeasurementPropertiesState
  propertiesSearch: string
  onPropertiesSearchChange: (next: string) => void
  selectedPropertyIds: readonly string[]
  onSelectedPropertyIdsChange: (next: readonly string[]) => void
  onContinue: (selectedPropertyIds: readonly string[]) => void
  isContinuing?: boolean
  onRetryProperties: () => void
  onReturnToImport: () => void
  maxVisibleProperties?: number
  onShowAllProperties?: () => void
  onAddProperty?: (input: DraftPropertyInput) => Promise<boolean>
}

const propertyStatePresentation = {
  proposed: { label: 'New', tone: 'caution' },
  confirmed: { label: 'Included', tone: 'positive' },
  excluded: { label: 'Excluded', tone: 'neutral' },
} as const

function normalizedSearch(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function matchesSearch(property: AdvancedMeasurementProperty, query: string): boolean {
  if (!query) return true
  return `${property.name} ${(property.urls ?? [property.url]).join(' ')}`.toLocaleLowerCase().includes(query)
}

function PropertyUrls({ property }: { property: AdvancedMeasurementProperty }) {
  const urls = property.urls ?? [property.url]
  if (urls.length <= 1) return <span>{urls[0] ?? 'No URL'}</span>
  return (
    <details>
      <summary className="cursor-pointer text-label-12-strong text-primary">{urls.length} URLs</summary>
      <ul className="mt-2 space-y-1">
        {urls.map(url => <li key={url} className="break-all text-label-12-mono text-secondary">{url}</li>)}
      </ul>
    </details>
  )
}

function ImportStep({
  canEdit,
  draft,
  onDraftChange,
  onReviewSitemap,
  reviewState,
  onAddProperty,
  propertyCount,
  onContinue,
  isBusy,
}: {
  canEdit: boolean
  draft: AdvancedMeasurementImportDraft
  onDraftChange: (next: AdvancedMeasurementImportDraft) => void
  onReviewSitemap: (draft: AdvancedMeasurementImportDraft) => void
  reviewState: AdvancedMeasurementReviewState
  onAddProperty?: (input: DraftPropertyInput) => Promise<boolean>
  propertyCount: number
  onContinue: () => void
  isBusy: boolean
}) {
  const [manual, setManual] = useState(false)
  const inputDisabled = !canEdit || isBusy || reviewState === 'reviewing'
  const reviewDisabled = inputDisabled
    || !draft.sitemapUrl.trim()
    || (!draft.examplePropertyUrl.trim() && !draft.propertyPathPattern.trim())

  function updateDraft(field: keyof AdvancedMeasurementImportDraft, value: string) {
    onDraftChange({ ...draft, [field]: value })
  }

  return (
    <section aria-labelledby="advanced-measurement-import-heading" aria-busy={reviewState === 'reviewing'}>
      <div>
        <h2 id="advanced-measurement-import-heading" className="text-heading-20 text-heading">Add Properties</h2>
      </div>

      {!canEdit ? (
        <div className="mt-4 flex items-center gap-2 text-label-14 text-secondary">
          <ToneBadge tone="neutral">Viewer access</ToneBadge>
          <span>You can inspect this setup.</span>
        </div>
      ) : null}

      {canEdit && onAddProperty ? <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Add Properties method">
        <Button type="button" disabled={inputDisabled} variant={manual ? 'outline' : 'default'} onClick={() => setManual(false)}>Import sitemap</Button>
        <Button type="button" disabled={inputDisabled} variant={manual ? 'default' : 'outline'} onClick={() => setManual(true)}>Add manually</Button>
      </div> : null}

      {manual && onAddProperty ? <div className="mt-5 space-y-5">
        <DraftPropertyEditor onSave={onAddProperty} onCancel={() => setManual(false)} />
        {propertyCount > 0 ? <div className="flex items-center justify-between gap-3 border-t border-default pt-4">
          <p role="status" className="text-copy-14 text-secondary">{propertyCount} {propertyCount === 1 ? 'Property' : 'Properties'} added</p>
          <Button type="button" disabled={inputDisabled} onClick={onContinue}>Continue with {propertyCount} {propertyCount === 1 ? 'Property' : 'Properties'}</Button>
        </div> : null}
      </div> : (

      <form
        className="mt-5 space-y-4"
        onSubmit={event => {
          event.preventDefault()
          if (reviewDisabled) return
          onReviewSitemap(draft)
        }}
      >
        <div>
          <label htmlFor="advanced-measurement-sitemap-url" className="text-label-14-strong text-heading">Sitemap URL</label>
          <input
            id="advanced-measurement-sitemap-url"
            type="url"
            value={draft.sitemapUrl}
            disabled={inputDisabled}
            onChange={event => updateDraft('sitemapUrl', event.target.value)}
            placeholder="https://example.com/sitemap.xml"
            className="mt-1 block w-full rounded-md border border-default bg-surface px-3 py-2 text-label-14 text-primary outline-none placeholder-mono-400 focus:border-strong focus:ring-2 focus:ring-mono-400 disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>

        <div>
          <label htmlFor="advanced-measurement-example-property-url" className="text-label-14-strong text-heading">Example Property page</label>
          <input
            id="advanced-measurement-example-property-url"
            type="url"
            required={!draft.propertyPathPattern.trim()}
            value={draft.examplePropertyUrl}
            disabled={inputDisabled}
            onChange={event => updateDraft('examplePropertyUrl', event.target.value)}
            placeholder="https://example.com/products/example"
            className="mt-1 block w-full rounded-md border border-default bg-surface px-3 py-2 text-label-14 text-primary outline-none placeholder-mono-400 focus:border-strong focus:ring-2 focus:ring-mono-400 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <p className="mt-1 text-copy-13 text-secondary">This shows Canonry the Property URL pattern. Or enter the pattern under More import options.</p>
        </div>

        <details className="material-base p-3">
          <summary className="cursor-pointer text-label-14-strong text-heading">More import options</summary>
          <div className="mt-4 space-y-4">
            <div>
              <label htmlFor="advanced-measurement-preferred-host" className="text-label-14-strong text-heading">Use URLs from this domain</label>
              <input
                id="advanced-measurement-preferred-host"
                value={draft.preferredHost}
                disabled={inputDisabled}
                onChange={event => updateDraft('preferredHost', event.target.value)}
                placeholder="example.com"
                className="mt-1 block w-full rounded-md border border-default bg-surface px-3 py-2 text-label-14 text-primary outline-none placeholder-mono-400 focus:border-strong focus:ring-2 focus:ring-mono-400 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>

            <div>
              <label htmlFor="advanced-measurement-property-path-pattern" className="text-label-14-strong text-heading">Property URL pattern</label>
              <input
                id="advanced-measurement-property-path-pattern"
                value={draft.propertyPathPattern}
                disabled={inputDisabled}
                onChange={event => updateDraft('propertyPathPattern', event.target.value)}
                placeholder="/products/*"
                className="mt-1 block w-full rounded-md border border-default bg-surface px-3 py-2 text-label-14 text-primary outline-none placeholder-mono-400 focus:border-strong focus:ring-2 focus:ring-mono-400 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label htmlFor="advanced-measurement-additional-host" className="text-label-14-strong text-heading">Additional URL domain</label>
                <input
                  id="advanced-measurement-additional-host"
                  value={draft.additionalHost}
                  disabled={inputDisabled}
                  onChange={event => updateDraft('additionalHost', event.target.value)}
                  placeholder="properties.example.com"
                  className="mt-1 block w-full rounded-md border border-default bg-surface px-3 py-2 text-label-14 text-primary outline-none placeholder-mono-400 focus:border-strong focus:ring-2 focus:ring-mono-400 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </div>
              <div>
                <label htmlFor="advanced-measurement-additional-path-pattern" className="text-label-14-strong text-heading">Additional URL pattern</label>
                <input
                  id="advanced-measurement-additional-path-pattern"
                  value={draft.additionalPathPattern}
                  disabled={inputDisabled}
                  onChange={event => updateDraft('additionalPathPattern', event.target.value)}
                  placeholder="/*"
                  className="mt-1 block w-full rounded-md border border-default bg-surface px-3 py-2 text-label-14 text-primary outline-none placeholder-mono-400 focus:border-strong focus:ring-2 focus:ring-mono-400 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </div>
              <p className="text-copy-14 text-secondary md:col-span-2">Use both fields when each Property also has a matching page on another domain.</p>
            </div>

            <div>
              <label htmlFor="advanced-measurement-excluded-paths" className="text-label-14-strong text-heading">Ignore these URL paths</label>
              <textarea
                id="advanced-measurement-excluded-paths"
                value={draft.excludedPaths}
                disabled={inputDisabled}
                onChange={event => updateDraft('excludedPaths', event.target.value)}
                placeholder="/products/archive"
                rows={3}
                className="mt-1 block w-full rounded-md border border-default bg-surface px-3 py-2 text-copy-14 text-primary outline-none placeholder-mono-400 focus:border-strong focus:ring-2 focus:ring-mono-400 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <p className="mt-1 text-copy-13 text-secondary">One path per line. Use * at the beginning or end to match similar pages.</p>
            </div>
          </div>
        </details>

        <Button type="submit" disabled={reviewDisabled}>
          {reviewState === 'reviewing' ? 'Reviewing sitemap…' : 'Review sitemap'}
        </Button>
      </form>
      )}
    </section>
  )
}

function PropertiesStep({
  canEdit,
  properties,
  propertiesState,
  propertiesSearch,
  onPropertiesSearchChange,
  selectedPropertyIds,
  onSelectedPropertyIdsChange,
  onContinue,
  isContinuing = false,
  onRetryProperties,
  onReturnToImport,
  maxVisibleProperties,
  onShowAllProperties,
}: Omit<AdvancedMeasurementImportPropertiesProps, 'activeStep' | 'importDraft' | 'onImportDraftChange' | 'onReviewSitemap' | 'reviewState'>) {
  const query = normalizedSearch(propertiesSearch)
  const filteredProperties = properties.filter(property => matchesSearch(property, query))
  const maximum = Math.max(1, maxVisibleProperties ?? filteredProperties.length)
  const visibleProperties = filteredProperties.slice(0, maximum)
  const selectedPropertyIdSet = new Set(selectedPropertyIds)
  const selectedIds = properties
    .filter(property => selectedPropertyIdSet.has(property.id))
    .map(property => property.id)
  const hasHiddenProperties = visibleProperties.length < filteredProperties.length

  function updateSelection(nextSelection: Iterable<string>) {
    const nextIds = new Set(nextSelection)
    onSelectedPropertyIdsChange(properties.filter(property => nextIds.has(property.id)).map(property => property.id))
  }

  function toggleProperty(id: string, selected: boolean) {
    if (!canEdit || isContinuing) return
    const current = new Set(selectedIds)
    if (selected) current.add(id)
    else current.delete(id)
    updateSelection(current)
  }

  function selectAllShown() {
    if (!canEdit || isContinuing) return
    updateSelection([...selectedIds, ...visibleProperties.map(property => property.id)])
  }

  function clearSelection() {
    if (!canEdit || isContinuing) return
    onSelectedPropertyIdsChange([])
  }

  function continueSetup() {
    if (!canEdit || isContinuing || selectedIds.length === 0) return
    onContinue(selectedIds)
  }

  return (
    <section aria-labelledby="advanced-measurement-properties-heading" aria-busy={propertiesState === 'loading' || isContinuing}>
      <div>
        <h2 id="advanced-measurement-properties-heading" className="text-heading-20 text-heading">Properties</h2>
        <p className="mt-1 max-w-2xl text-copy-14 text-secondary">Choose the Properties to include, then continue.</p>
      </div>

      {!canEdit ? <p className="mt-4 text-copy-14 text-secondary">Viewing only. Property changes are unavailable.</p> : null}

      {propertiesState === 'loading' ? (
        <div className="mt-5 material-base p-4">
          <p role="status" className="text-copy-14 text-secondary">Loading Properties…</p>
          <p className="mt-1 text-copy-14 text-secondary">If this does not finish, refresh the list.</p>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onRetryProperties}>Refresh Properties</Button>
        </div>
      ) : null}

      {propertiesState === 'error' ? (
        <div className="mt-5 material-base p-4">
          <p role="alert" className="text-copy-14 text-negative">Could not load Properties. Retry to request the current list.</p>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onRetryProperties}>Retry</Button>
        </div>
      ) : null}

      {propertiesState === 'ready' && properties.length === 0 ? (
        <div className="mt-5 material-base p-4">
          <p className="text-copy-14 text-secondary">No Properties were found.</p>
          <p className="mt-1 text-copy-14 text-secondary">Check the sitemap and review it again.</p>
          <Button type="button" variant="outline" size="sm" className="mt-3" disabled={!canEdit} onClick={onReturnToImport}>Review sitemap</Button>
        </div>
      ) : null}

      {propertiesState === 'ready' && properties.length > 0 ? (
        <div className="mt-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <label className="block min-w-48 flex-1">
              <span className="text-label-14-strong text-heading">Search Properties</span>
              <input
                type="search"
                value={propertiesSearch}
                disabled={isContinuing}
                onChange={event => onPropertiesSearchChange(event.target.value)}
                className="mt-1 block w-full rounded-md border border-default bg-surface px-3 py-2 text-label-14 text-primary outline-none placeholder-mono-400 focus:border-strong focus:ring-2 focus:ring-mono-400"
              />
            </label>
            {canEdit ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" disabled={isContinuing} onClick={selectAllShown}>Select all shown</Button>
                <Button type="button" variant="ghost" size="sm" disabled={isContinuing || selectedIds.length === 0} onClick={clearSelection}>Clear selection</Button>
              </div>
            ) : null}
          </div>

          {filteredProperties.length === 0 ? (
            <div className="mt-4 material-base p-4">
              <p className="text-copy-14 text-secondary">No Properties match this search.</p>
              <p className="mt-1 text-copy-14 text-secondary">Clear the search or review the sitemap again.</p>
              <Button type="button" variant="outline" size="sm" className="mt-3" disabled={!canEdit} onClick={onReturnToImport}>Review sitemap</Button>
            </div>
          ) : (
            <>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-label-14 text-secondary">
                <p>Showing {visibleProperties.length} of {filteredProperties.length} Properties</p>
                <p>{selectedIds.length} of {properties.length} selected</p>
              </div>
              <div className="mt-2 overflow-x-auto rounded-md border border-default">
                <table className="w-full min-w-150 text-left text-label-14" aria-label="Properties to review">
                  <thead className="bg-surface-subtle text-label-12-strong normal-case text-secondary">
                    <tr>
                      <th scope="col" className="px-3 py-2">Property</th>
                      <th scope="col" className="px-3 py-2">URL</th>
                      <th scope="col" className="px-3 py-2">State</th>
                      {canEdit ? <th scope="col" className="px-3 py-2 text-right">Include</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleProperties.map(property => {
                      const presentation = propertyStatePresentation[property.state]
                      return (
                        <tr key={property.id} className="border-t border-subtle">
                          <td className="px-3 py-3 text-label-14-strong text-heading">{property.name}</td>
                          <td className="max-w-96 px-3 py-3 text-label-12-mono text-secondary"><PropertyUrls property={property} /></td>
                          <td className="px-3 py-3"><ToneBadge tone={presentation.tone}>{presentation.label}</ToneBadge></td>
                          {canEdit ? <td className="p-0 text-right">
                            <label className="ml-auto flex min-h-11 min-w-11 cursor-pointer items-center justify-center">
                              <input
                                type="checkbox"
                                aria-label={`Select ${property.name}`}
                                checked={selectedIds.includes(property.id)}
                                disabled={isContinuing}
                                onChange={event => toggleProperty(property.id, event.target.checked)}
                                className="size-6 accent-accent"
                              />
                            </label>
                          </td> : null}
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {hasHiddenProperties && onShowAllProperties ? <Button type="button" variant="outline" size="sm" className="mt-3" disabled={isContinuing} onClick={onShowAllProperties}>Show all Properties</Button> : null}
            </>
          )}
          {canEdit ? (
            <div className="mt-4 flex items-center justify-between gap-3">
              <Button type="button" variant="ghost" disabled={isContinuing} onClick={onReturnToImport}>Add Properties</Button>
              <Button type="button" disabled={isContinuing || selectedIds.length === 0} onClick={continueSetup}>
                {isContinuing ? 'Saving Properties…' : `Continue with ${selectedIds.length} ${selectedIds.length === 1 ? 'Property' : 'Properties'}`}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

export function SetupImportProperties(props: AdvancedMeasurementImportPropertiesProps) {
  if (props.activeStep === 'import') {
    return (
      <ImportStep
        canEdit={props.canEdit}
        draft={props.importDraft}
        onDraftChange={props.onImportDraftChange}
        onReviewSitemap={props.onReviewSitemap}
        reviewState={props.reviewState}
        onAddProperty={props.onAddProperty}
        propertyCount={props.properties.filter(property => property.state === 'confirmed').length}
        onContinue={() => props.onContinue(props.selectedPropertyIds)}
        isBusy={props.isContinuing ?? false}
      />
    )
  }

  return <PropertiesStep {...props} />
}

export interface DraftPropertyIdentity {
  id: string
  name: string
  aliases: readonly string[]
  identityAliases: readonly string[]
  urls: readonly string[]
}

export interface DraftPropertyInput {
  name: string
  aliases: string[]
  identityAliases: string[]
  urls: string[]
}

/** Uses the draft's actual matching names, not a display label inferred from a URL. */
export function DraftPropertyEditor({ property, onSave, onCancel }: {
  property?: DraftPropertyIdentity
  onSave: (input: DraftPropertyInput) => Promise<boolean>
  onCancel: () => void
}) {
  const fieldId = useId()
  const nameRef = useRef<HTMLInputElement>(null)
  const returnFocusRef = useRef(false)
  const [name, setName] = useState(property?.name ?? '')
  const [aliases, setAliases] = useState(property?.aliases.join('\n') ?? '')
  const [qualified, setQualified] = useState(property?.identityAliases.join('\n') ?? '')
  const [url, setUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const inputClass = 'mt-1 block w-full rounded-md border border-default bg-surface px-3 py-2 text-copy-14 text-primary focus:border-strong focus:outline-none focus:ring-2 focus:ring-mono-400'

  useEffect(() => { nameRef.current?.focus() }, [])
  useEffect(() => {
    if (!saving && returnFocusRef.current) {
      returnFocusRef.current = false
      nameRef.current?.focus()
    }
  }, [saving, name])

  async function save() {
    setSaving(true)
    try {
      const saved = await onSave({
        name: name.trim(),
        aliases: property ? aliases.split('\n').map(value => value.trim()).filter(Boolean) : [name.trim()],
        identityAliases: qualified.split('\n').map(value => value.trim()).filter(Boolean),
        urls: property ? [...property.urls] : [url.trim()],
      })
      if (saved && !property) {
        setName('')
        setUrl('')
        setQualified('')
        returnFocusRef.current = true
      }
    } finally {
      setSaving(false)
    }
  }

  return (
    <form className="max-w-2xl space-y-4" onSubmit={event => { event.preventDefault(); void save() }} aria-busy={saving}>
      <label className="block text-label-14-strong text-heading" htmlFor={`${fieldId}-name`}>
        Property name
        <input ref={nameRef} id={`${fieldId}-name`} required value={name} disabled={saving} onChange={event => setName(event.target.value)} className={inputClass} />
      </label>
      {property ? <>
        <label className="block text-label-14-strong text-heading" htmlFor={`${fieldId}-names`}>
          Names that count as a mention
          <textarea id={`${fieldId}-names`} value={aliases} disabled={saving} onChange={event => setAliases(event.target.value)} className={inputClass} rows={3} aria-describedby={`${fieldId}-names-help`} />
        </label>
        <p id={`${fieldId}-names-help`} className="text-copy-13 text-secondary">One name per line. Use names for this specific Property; a shared brand name also matches other Properties.</p>
        <details>
          <summary className="min-h-11 cursor-pointer text-label-14-strong text-heading">Qualified names (optional)</summary>
          <label className="block text-copy-13 text-secondary" htmlFor={`${fieldId}-qualified`}>
            Longer names that distinguish this Property when a plain name is shared.
            <textarea id={`${fieldId}-qualified`} value={qualified} disabled={saving} onChange={event => setQualified(event.target.value)} className={inputClass} rows={3} />
          </label>
        </details>
      </> : <>
        <label className="block text-label-14-strong text-heading" htmlFor={`${fieldId}-url`}>
          Property page URL
          <input id={`${fieldId}-url`} type="url" pattern="https?://.*" title="Enter a full http or https page URL" required value={url} disabled={saving} onChange={event => setUrl(event.target.value)} className={inputClass} placeholder="https://example.com/products/example" />
        </label>
        <p className="text-copy-13 text-secondary">The name matches mentions; the page URL matches citations. You can review both before publishing.</p>
      </>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={saving || !name.trim()}>{saving ? 'Saving…' : property ? 'Save Property' : 'Add Property'}</Button>
        <Button type="button" variant="ghost" disabled={saving} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  )
}

export function PropertyIdentityReview({ properties, onSave, onEditingChange }: {
  properties: readonly DraftPropertyIdentity[]
  onSave?: (id: string, input: DraftPropertyInput) => Promise<boolean>
  onEditingChange?: (editing: boolean) => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [limit, setLimit] = useState(20)
  function edit(id: string | null) {
    setEditing(id)
    onEditingChange?.(id !== null)
  }
  return (
    <section aria-label="Property matching" className="space-y-3">
      <div className="flex items-center gap-1.5"><h4 className="text-heading-14 text-heading">Property matching</h4><InfoTooltip text="Check the names and URLs used to measure each Property. Display names alone do not change matching." /></div>
      <ul className="divide-y divide-subtle border-y border-default">
        {properties.slice(0, limit).map(property => <li key={property.id} className="py-3">
          {editing === property.id && onSave ? <DraftPropertyEditor property={property} onCancel={() => edit(null)} onSave={async input => {
            const saved = await onSave(property.id, input)
            if (saved) edit(null)
            return saved
          }} /> : <>
            <div className="flex items-start justify-between gap-3">
              <h5 className="text-label-14-strong text-heading">{property.name}</h5>
              {onSave ? <Button type="button" size="sm" variant="ghost" disabled={editing !== null} aria-label={`Edit matching for ${property.name}`} onClick={() => edit(property.id)}>Edit names</Button> : null}
            </div>
            <dl className="grid gap-x-4 gap-y-1 text-copy-13 sm:grid-cols-[auto_minmax(0,1fr)]">
              <dt className="text-secondary">Mention names</dt><dd className="break-words text-primary">{property.aliases.length > 0 ? property.aliases.join(', ') : 'No names configured'}</dd>
              {property.identityAliases.length > 0 ? <><dt className="text-secondary">Qualified names</dt><dd className="break-words text-primary">{property.identityAliases.join(', ')}</dd></> : null}
              <dt className="text-secondary">Citation URLs</dt><dd className="break-all text-primary">{property.urls.length > 0 ? property.urls.join(', ') : 'No citation URLs configured'}</dd>
            </dl>
          </>}
        </li>)}
      </ul>
      {properties.length > limit ? <Button type="button" variant="outline" size="sm" onClick={() => setLimit(value => value + 20)}>Show more Properties</Button> : null}
    </section>
  )
}
