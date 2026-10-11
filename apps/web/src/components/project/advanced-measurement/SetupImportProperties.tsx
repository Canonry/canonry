import { AlertTriangle, Eye, Info } from 'lucide-react'

import { Button } from '../../ui/button.js'
import { InfoTooltip } from '../../shared/InfoTooltip.js'
import { StatusNote } from '../../shared/StatusNote.js'
import { ToneBadge } from '../../shared/ToneBadge.js'

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
      <summary className="cursor-pointer text-xs font-medium text-primary">{urls.length} URLs</summary>
      <ul className="mt-2 space-y-1">
        {urls.map(url => <li key={url} className="break-all font-mono text-xs text-secondary">{url}</li>)}
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
}: {
  canEdit: boolean
  draft: AdvancedMeasurementImportDraft
  onDraftChange: (next: AdvancedMeasurementImportDraft) => void
  onReviewSitemap: (draft: AdvancedMeasurementImportDraft) => void
  reviewState: AdvancedMeasurementReviewState
}) {
  const inputDisabled = !canEdit || reviewState === 'reviewing'
  const reviewDisabled = inputDisabled
    || !draft.sitemapUrl.trim()
    || (!draft.examplePropertyUrl.trim() && !draft.propertyPathPattern.trim())

  function updateDraft(field: keyof AdvancedMeasurementImportDraft, value: string) {
    onDraftChange({ ...draft, [field]: value })
  }

  return (
    <section aria-labelledby="advanced-measurement-import-heading" aria-busy={reviewState === 'reviewing'}>
      <div className="flex items-center gap-1">
        <h2 id="advanced-measurement-import-heading" className="text-lg font-semibold text-heading">Import locations</h2>
        <InfoTooltip placement="bottom" text="Review sitemap entries before choosing the locations to measure." />
      </div>

      {!canEdit ? (
        <div className="mt-4 flex items-center gap-2 text-sm text-secondary">
          <ToneBadge tone="neutral">Viewer access</ToneBadge>
          <span>You can inspect this setup.</span>
        </div>
      ) : null}

      <form
        className="mt-5 space-y-4"
        onSubmit={event => {
          event.preventDefault()
          if (reviewDisabled) return
          onReviewSitemap(draft)
        }}
      >
        <div>
          <label htmlFor="advanced-measurement-sitemap-url" className="text-sm font-medium text-heading">Sitemap URL</label>
          <input
            id="advanced-measurement-sitemap-url"
            type="url"
            value={draft.sitemapUrl}
            disabled={inputDisabled}
            onChange={event => updateDraft('sitemapUrl', event.target.value)}
            placeholder="https://example.com/sitemap.xml"
            className="mt-1 block w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-primary outline-none placeholder-mono-600 focus:border-strong focus:ring-2 focus:ring-mono-400 disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>

        <div>
          <div className="flex items-center gap-1">
            <label htmlFor="advanced-measurement-example-property-url" className="text-sm font-medium text-heading">Example location page</label>
            <InfoTooltip placement="bottom" text="This shows Canonry the location URL pattern. Or enter the pattern under More import options." />
          </div>
          <input
            id="advanced-measurement-example-property-url"
            type="url"
            required={!draft.propertyPathPattern.trim()}
            value={draft.examplePropertyUrl}
            disabled={inputDisabled}
            onChange={event => updateDraft('examplePropertyUrl', event.target.value)}
            placeholder="https://example.com/locations/example"
            className="mt-1 block w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-primary outline-none placeholder-mono-600 focus:border-strong focus:ring-2 focus:ring-mono-400 disabled:cursor-not-allowed disabled:opacity-60"
          />
        </div>

        <details className="rounded-md border border-default bg-surface-subtle p-3">
          <summary className="cursor-pointer text-sm font-medium text-heading">More import options</summary>
          <div className="mt-4 space-y-4">
            <div>
              <label htmlFor="advanced-measurement-preferred-host" className="text-sm font-medium text-heading">Use URLs from this domain</label>
              <input
                id="advanced-measurement-preferred-host"
                value={draft.preferredHost}
                disabled={inputDisabled}
                onChange={event => updateDraft('preferredHost', event.target.value)}
                placeholder="example.com"
                className="mt-1 block w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-primary outline-none placeholder-mono-600 focus:border-strong focus:ring-2 focus:ring-mono-400 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>

            <div>
              <label htmlFor="advanced-measurement-property-path-pattern" className="text-sm font-medium text-heading">Location URL pattern</label>
              <input
                id="advanced-measurement-property-path-pattern"
                value={draft.propertyPathPattern}
                disabled={inputDisabled}
                onChange={event => updateDraft('propertyPathPattern', event.target.value)}
                placeholder="/locations/*"
                className="mt-1 block w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-primary outline-none placeholder-mono-600 focus:border-strong focus:ring-2 focus:ring-mono-400 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label htmlFor="advanced-measurement-additional-host" className="text-sm font-medium text-heading">Additional URL domain</label>
                <input
                  id="advanced-measurement-additional-host"
                  value={draft.additionalHost}
                  disabled={inputDisabled}
                  onChange={event => updateDraft('additionalHost', event.target.value)}
                  placeholder="locations.example.com"
                  className="mt-1 block w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-primary outline-none placeholder-mono-600 focus:border-strong focus:ring-2 focus:ring-mono-400 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </div>
              <div>
                <label htmlFor="advanced-measurement-additional-path-pattern" className="text-sm font-medium text-heading">Additional URL pattern</label>
                <input
                  id="advanced-measurement-additional-path-pattern"
                  value={draft.additionalPathPattern}
                  disabled={inputDisabled}
                  onChange={event => updateDraft('additionalPathPattern', event.target.value)}
                  placeholder="/*"
                  className="mt-1 block w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-primary outline-none placeholder-mono-600 focus:border-strong focus:ring-2 focus:ring-mono-400 disabled:cursor-not-allowed disabled:opacity-60"
                />
              </div>
              <div className="md:col-span-2">
                <StatusNote icon={Info} label="Use both fields" detail="Fill in both when each location also has a matching page on another domain." />
              </div>
            </div>

            <div>
              <label htmlFor="advanced-measurement-excluded-paths" className="text-sm font-medium text-heading">Ignore these URL paths</label>
              <textarea
                id="advanced-measurement-excluded-paths"
                value={draft.excludedPaths}
                disabled={inputDisabled}
                onChange={event => updateDraft('excludedPaths', event.target.value)}
                placeholder="/locations/archive"
                rows={3}
                className="mt-1 block w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-primary outline-none placeholder-mono-600 focus:border-strong focus:ring-2 focus:ring-mono-400 disabled:cursor-not-allowed disabled:opacity-60"
              />
              <p className="mt-1 text-xs text-secondary">One path per line. Use * at the beginning or end to match similar pages.</p>
            </div>
          </div>
        </details>

        <Button type="submit" disabled={reviewDisabled}>
          {reviewState === 'reviewing' ? 'Reviewing sitemap…' : 'Review sitemap'}
        </Button>
      </form>
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
      <div className="flex items-center gap-1">
        <h2 id="advanced-measurement-properties-heading" className="text-lg font-semibold text-heading">Locations</h2>
        <InfoTooltip placement="bottom" text="Choose the locations to include, then continue." />
      </div>

      {!canEdit ? <div className="mt-4"><StatusNote icon={Eye} label="View only" detail="Location changes are unavailable." /></div> : null}

      {propertiesState === 'loading' ? (
        <div className="mt-5 rounded-md border border-default bg-surface-subtle p-4">
          <p role="status" className="text-sm text-secondary">Loading locations…</p>
          <p className="mt-1 text-sm text-secondary">If this does not finish, refresh the list.</p>
          <Button type="button" variant="outline" size="sm" className="mt-3" onClick={onRetryProperties}>Refresh locations</Button>
        </div>
      ) : null}

      {propertiesState === 'error' ? (
        <div role="alert" className="mt-5 rounded-md border border-default bg-surface-subtle p-4">
          <StatusNote
            icon={AlertTriangle}
            tone="negative"
            label="Could not load"
            action={<Button type="button" variant="outline" size="sm" onClick={onRetryProperties}>Retry</Button>}
          />
        </div>
      ) : null}

      {propertiesState === 'ready' && properties.length === 0 ? (
        <div className="mt-5 rounded-md border border-default bg-surface-subtle p-4">
          <p className="text-sm text-secondary">No locations found.</p>
          <p className="mt-1 text-sm text-secondary">Check the sitemap and review it again.</p>
          <Button type="button" variant="outline" size="sm" className="mt-3" disabled={!canEdit} onClick={onReturnToImport}>Review sitemap</Button>
        </div>
      ) : null}

      {propertiesState === 'ready' && properties.length > 0 ? (
        <div className="mt-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <label className="block min-w-48 flex-1">
              <span className="text-sm font-medium text-heading">Search locations</span>
              <input
                type="search"
                value={propertiesSearch}
                disabled={isContinuing}
                onChange={event => onPropertiesSearchChange(event.target.value)}
                className="mt-1 block w-full rounded-md border border-default bg-surface px-3 py-2 text-sm text-primary outline-none placeholder-mono-600 focus:border-strong focus:ring-2 focus:ring-mono-400"
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
            <div className="mt-4 rounded-md border border-default bg-surface-subtle p-4">
              <p className="text-sm text-secondary">No locations match this search.</p>
              <p className="mt-1 text-sm text-secondary">Clear the search or review the sitemap again.</p>
              <Button type="button" variant="outline" size="sm" className="mt-3" disabled={!canEdit} onClick={onReturnToImport}>Review sitemap</Button>
            </div>
          ) : (
            <>
              <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm text-secondary">
                <p>Showing {visibleProperties.length} of {filteredProperties.length} locations</p>
                <p>{selectedIds.length} of {properties.length} selected</p>
              </div>
              <div className="mt-2 overflow-x-auto rounded-md border border-default">
                <table className="w-full min-w-150 text-left text-sm" aria-label="Locations to review">
                  <thead className="bg-surface-subtle text-xs font-medium uppercase tracking-wide text-secondary">
                    <tr>
                      <th scope="col" className="px-3 py-2">Location</th>
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
                          <td className="px-3 py-3 font-medium text-heading">{property.name}</td>
                          <td className="max-w-96 px-3 py-3 font-mono text-xs text-secondary"><PropertyUrls property={property} /></td>
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
              {hasHiddenProperties && onShowAllProperties ? <Button type="button" variant="outline" size="sm" className="mt-3" disabled={isContinuing} onClick={onShowAllProperties}>Show all locations</Button> : null}
            </>
          )}
          {canEdit ? (
            <div className="mt-4 flex items-center justify-between gap-3">
              <Button type="button" variant="ghost" disabled={isContinuing} onClick={onReturnToImport}>Back</Button>
              <Button type="button" disabled={isContinuing || selectedIds.length === 0} onClick={continueSetup}>
                {isContinuing ? 'Saving locations…' : 'Continue'}
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
      />
    )
  }

  return <PropertiesStep {...props} />
}
