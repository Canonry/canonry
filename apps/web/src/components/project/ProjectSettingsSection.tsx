import { useEffect, useId, useState } from 'react'
import { formatLocaleLabel, type ResultsExportFormat } from '@canonry/canonry-contracts'

import { Button } from '../ui/button.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { addLocation, downloadResultsExport, removeLocation, setDefaultLocation, isEmbed, isPublicDemo, type ApiLocation } from '../../api.js'
import { addToast } from '../../lib/toast-store.js'
import { asyncHandler } from '../../lib/async-handler.js'

export function ProjectSettingsSection({
  project,
  onUpdateProject,
}: {
  project: { name: string; displayName: string; canonicalDomain: string; ownedDomains: string[]; aliases: string[]; country: string; language: string; tags?: string[]; locations: Array<{ label: string; city: string; region: string; country: string; timezone?: string }>; defaultLocation: string | null }
  onUpdateProject: (projectName: string, updates: { displayName?: string; canonicalDomain?: string; ownedDomains?: string[]; aliases?: string[]; country?: string; language?: string; locations?: Array<{ label: string; city: string; region: string; country: string; timezone?: string }>; defaultLocation?: string | null }) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [displayName, setDisplayName] = useState(project.displayName)
  const [canonicalDomain, setCanonicalDomain] = useState(project.canonicalDomain)
  const [country, setCountry] = useState(project.country)
  const [language, setLanguage] = useState(project.language)
  const [ownedDomains, setOwnedDomains] = useState<string[]>(project.ownedDomains ?? [])
  const [newDomain, setNewDomain] = useState('')
  const [aliases, setAliases] = useState<string[]>(project.aliases ?? [])
  const [newAlias, setNewAlias] = useState('')

  // Location management state
  const [locationError, setLocationError] = useState<string | null>(null)
  const [locationWorking, setLocationWorking] = useState(false)
  const [showAddLocation, setShowAddLocation] = useState(false)
  const [newLocLabel, setNewLocLabel] = useState('')
  const [newLocCity, setNewLocCity] = useState('')
  const [newLocRegion, setNewLocRegion] = useState('')
  const [newLocCountry, setNewLocCountry] = useState('')
  const [newLocTimezone, setNewLocTimezone] = useState('')
  const [exportingFormat, setExportingFormat] = useState<ResultsExportFormat | null>(null)
  const [resultsExportError, setResultsExportError] = useState<string | null>(null)
  const fieldId = useId()

  // Sync local state when project prop changes (e.g. after save)
  useEffect(() => {
    if (!editing) {
      setDisplayName(project.displayName)
      setCanonicalDomain(project.canonicalDomain)
      setCountry(project.country)
      setLanguage(project.language)
      setOwnedDomains(project.ownedDomains ?? [])
      setAliases(project.aliases ?? [])
    }
  }, [project, editing])

  function handleCancel() {
    setEditing(false)
    setError(null)
    setDisplayName(project.displayName)
    setCanonicalDomain(project.canonicalDomain)
    setCountry(project.country)
    setLanguage(project.language)
    setOwnedDomains(project.ownedDomains ?? [])
    setAliases(project.aliases ?? [])
    setNewDomain('')
    setNewAlias('')
  }

  function handleAddDomain() {
    const d = newDomain.trim()
    if (!d) return
    if (!ownedDomains.includes(d)) {
      setOwnedDomains([...ownedDomains, d])
    }
    setNewDomain('')
  }

  function handleRemoveDomain(domain: string) {
    setOwnedDomains(ownedDomains.filter(d => d !== domain))
  }

  function handleAddAlias() {
    const a = newAlias.trim()
    if (!a) return
    const key = a.toLowerCase()
    if (!aliases.some(existing => existing.toLowerCase() === key)) {
      setAliases([...aliases, a])
    }
    setNewAlias('')
  }

  function handleRemoveAlias(alias: string) {
    setAliases(aliases.filter(a => a !== alias))
  }

  async function handleSave() {
    if (!displayName.trim() || !canonicalDomain.trim() || !country.trim() || !language.trim()) return
    setSaving(true)
    setError(null)
    try {
      await onUpdateProject(project.name, {
        displayName: displayName.trim(),
        canonicalDomain: canonicalDomain.trim(),
        ownedDomains,
        aliases,
        country: country.trim(),
        language: language.trim(),
      })
      setEditing(false)
      addToast({
        title: 'Project settings saved',
        detail: `${displayName.trim()} was updated.`,
        tone: 'positive',
        dedupeKey: `project:update:${project.name}`,
        dedupeMode: 'replace',
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function handleAddLocation() {
    const label = newLocLabel.trim()
    const city = newLocCity.trim()
    const region = newLocRegion.trim()
    const locCountry = newLocCountry.trim()
    if (!label || !city || !region || !locCountry) return
    setLocationWorking(true)
    setLocationError(null)
    try {
      const loc: ApiLocation = { label, city, region, country: locCountry }
      if (newLocTimezone.trim()) loc.timezone = newLocTimezone.trim()
      await addLocation(project.name, loc)
      setNewLocLabel('')
      setNewLocCity('')
      setNewLocRegion('')
      setNewLocCountry('')
      setNewLocTimezone('')
      setShowAddLocation(false)
      addToast({
        title: 'Search location added',
        detail: `${label} is now available for ${project.name}.`,
        tone: 'positive',
        dedupeKey: `project:location:add:${project.name}:${label}`,
        dedupeMode: 'drop',
      })
    } catch (err) {
      setLocationError(err instanceof Error ? err.message : 'Failed to add search location')
    } finally {
      setLocationWorking(false)
    }
  }

  async function handleRemoveLocation(label: string) {
    setLocationWorking(true)
    setLocationError(null)
    try {
      await removeLocation(project.name, label)
      addToast({
        title: 'Search location removed',
        detail: `${label} was removed from ${project.name}.`,
        tone: 'positive',
        dedupeKey: `project:location:remove:${project.name}:${label}`,
        dedupeMode: 'drop',
      })
    } catch (err) {
      setLocationError(err instanceof Error ? err.message : 'Failed to remove search location')
    } finally {
      setLocationWorking(false)
    }
  }

  async function handleSetDefaultLocation(label: string) {
    setLocationWorking(true)
    setLocationError(null)
    try {
      await setDefaultLocation(project.name, label)
      addToast({
        title: 'Default search location updated',
        detail: `${label} is now the default for ${project.name}.`,
        tone: 'positive',
        dedupeKey: `project:location:default:${project.name}`,
        dedupeMode: 'replace',
      })
    } catch (err) {
      setLocationError(err instanceof Error ? err.message : 'Failed to set default search location')
    } finally {
      setLocationWorking(false)
    }
  }

  async function handleResultsExport(format: ResultsExportFormat) {
    setExportingFormat(format)
    setResultsExportError(null)
    try {
      await downloadResultsExport(project.name, format)
      addToast({
        title: `${format.toUpperCase()} download started`,
        detail: `Historical citation and mention results for ${project.displayName}.`,
        tone: 'positive',
        dedupeKey: `project:results-export:${project.name}`,
        dedupeMode: 'replace',
      })
    } catch (err) {
      setResultsExportError(err instanceof Error ? err.message : 'Could not download tracking results.')
    } finally {
      setExportingFormat(null)
    }
  }

  const hasChanges = displayName !== project.displayName ||
    canonicalDomain !== project.canonicalDomain ||
    country !== project.country ||
    language !== project.language ||
    JSON.stringify(ownedDomains) !== JSON.stringify(project.ownedDomains ?? []) ||
    JSON.stringify(aliases) !== JSON.stringify(project.aliases ?? [])

  // An embed and the public demo are view only: stored settings stay readable,
  // but nothing that would change them is offered.
  const canChange = !isEmbed() && !isPublicDemo()
  const inputClass = 'w-full rounded border border-strong bg-transparent px-2 py-1.5 text-label-14 text-strong placeholder-mono-400 focus:border-mono-500 focus:outline-none'
  const labelClass = 'mb-1 block text-label-14-strong text-secondary'
  const newLocValid = newLocLabel.trim() && newLocCity.trim() && newLocRegion.trim() && newLocCountry.trim()

  return (
    <>
      <section className="page-section">
      <div className="section-head section-head-inline">
        <div>
          <h2>Project settings</h2>
        </div>
        {canChange && !editing && (
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            Edit settings
          </Button>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-negative-800/40 bg-negative-950/20 px-3 py-2 text-label-14 text-negative">
          {error}
          <button type="button" className="ml-2 text-negative-400 hover:text-negative-200" onClick={() => setError(null)}>×</button>
        </div>
      )}

      {canChange && editing ? (
        <div className="material-base p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor={`${fieldId}-display-name`} className={labelClass}>Display name</label>
              <input id={`${fieldId}-display-name`} className={inputClass} type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="My Project" />
            </div>
            <div>
              <label htmlFor={`${fieldId}-main-domain`} className={labelClass}>Main domain</label>
              <input id={`${fieldId}-main-domain`} className={inputClass} type="text" value={canonicalDomain} onChange={(e) => setCanonicalDomain(e.target.value)} placeholder="example.com" />
            </div>
            <div>
              <label htmlFor={`${fieldId}-country`} className={labelClass}>Country</label>
              <input id={`${fieldId}-country`} className={inputClass} type="text" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="US" maxLength={2} />
            </div>
            <div>
              <label htmlFor={`${fieldId}-language`} className={labelClass}>Language</label>
              <input id={`${fieldId}-language`} className={inputClass} type="text" value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="en" />
            </div>
          </div>

          <div>
            <label htmlFor={`${fieldId}-owned-domain`} className={labelClass}>Owned domains</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {ownedDomains.map((d) => (
                <span key={d} className="inline-flex items-center gap-1 rounded-md border border-mono-700/60 bg-mono-800/40 px-2 py-1 text-label-12 text-neutral">
                  {d}
                  <button type="button" className="ml-0.5 text-muted hover:text-strong transition-colors" onClick={() => handleRemoveDomain(d)} aria-label={`Remove ${d}`}>×</button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                id={`${fieldId}-owned-domain`}
                className={`${inputClass} flex-1`}
                type="text"
                placeholder="docs.example.com"
                value={newDomain}
                onChange={(e) => setNewDomain(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddDomain())}
              />
              <Button type="button" variant="outline" size="sm" disabled={!newDomain.trim()} onClick={handleAddDomain}>
                Add
              </Button>
            </div>
          </div>

          <div>
            <label htmlFor={`${fieldId}-alias`} className={labelClass}>Aliases</label>
            <p className="mb-1.5 text-copy-14 text-secondary">
              Other brand names that may appear in answers.
            </p>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {aliases.map((a) => (
                <span key={a} className="inline-flex items-center gap-1 rounded-md border border-mono-700/60 bg-mono-800/40 px-2 py-1 text-label-12 text-neutral">
                  {a}
                  <button type="button" className="ml-0.5 text-muted hover:text-strong transition-colors" onClick={() => handleRemoveAlias(a)} aria-label={`Remove ${a}`}>×</button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                id={`${fieldId}-alias`}
                className={`${inputClass} flex-1`}
                type="text"
                placeholder="Facebook"
                value={newAlias}
                onChange={(e) => setNewAlias(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), handleAddAlias())}
              />
              <Button type="button" variant="outline" size="sm" disabled={!newAlias.trim()} onClick={handleAddAlias}>
                Add
              </Button>
            </div>
          </div>

          <div className="flex items-center gap-2 pt-2 border-t border-default">
            <Button type="button" disabled={saving || !hasChanges || !displayName.trim() || !canonicalDomain.trim()} onClick={asyncHandler(handleSave)}>
              {saving ? 'Saving...' : 'Save changes'}
            </Button>
            <Button type="button" variant="outline" disabled={saving} onClick={handleCancel}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="material-base overflow-hidden">
          <table className="w-full text-label-14">
            <tbody>
              <tr className="border-b border-subtle">
                <td className="px-4 py-2.5 text-muted text-label-14-strong w-40">Display name</td>
                <td className="px-4 py-2.5 text-strong">{project.displayName || '\u2014'}</td>
              </tr>
              <tr className="border-b border-subtle">
                <td className="px-4 py-2.5 text-muted text-label-14-strong">Main domain</td>
                <td className="px-4 py-2.5 text-strong">{project.canonicalDomain}</td>
              </tr>
              <tr className="border-b border-subtle">
                <td className="px-4 py-2.5 text-muted text-label-14-strong">Owned domains</td>
                <td className="px-4 py-2.5">
                  {(project.ownedDomains ?? []).length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {project.ownedDomains.map((d) => (
                        <span key={d} className="rounded-md border border-mono-700/60 bg-mono-800/40 px-2 py-1 text-label-12 text-neutral">{d}</span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-muted">{'\u2014'}</span>
                  )}
                </td>
              </tr>
              <tr className="border-b border-subtle">
                <td className="px-4 py-2.5 text-muted text-label-14-strong">Aliases</td>
                <td className="px-4 py-2.5">
                  {(project.aliases ?? []).length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {project.aliases.map((a) => (
                        <span key={a} className="rounded-md border border-mono-700/60 bg-mono-800/40 px-2 py-1 text-label-12 text-neutral">{a}</span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-muted">{'\u2014'}</span>
                  )}
                </td>
              </tr>
              <tr className="border-b border-subtle">
                {/* Setup's name for the project's country and language. */}
                <td className="px-4 py-2.5 text-muted text-label-14-strong">Market</td>
                <td className="px-4 py-2.5 text-strong">{formatLocaleLabel(project.country, project.language)}</td>
              </tr>
              {project.tags?.length ? (
                <tr className="border-b border-subtle">
                  <td className="px-4 py-2.5 text-muted text-label-14-strong">Tags</td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1.5">
                      {project.tags.map((tag) => (
                        <span key={tag} className="rounded-md border border-mono-700/60 bg-mono-800/40 px-2 py-1 text-label-12 text-neutral">{tag}</span>
                      ))}
                    </div>
                  </td>
                </tr>
              ) : null}
              <tr>
                <td className="px-4 py-2.5 text-muted text-label-14-strong align-top pt-3">Search locations</td>
                <td className="px-4 py-2.5">
                  {locationError && (
                    <div className="mb-2 rounded border border-negative-800/40 bg-negative-950/20 px-2 py-1 text-label-12 text-negative">
                      {locationError}
                      <button type="button" className="ml-1 text-negative-400 hover:text-negative-200" onClick={() => setLocationError(null)}>×</button>
                    </div>
                  )}
                  {(project.locations ?? []).length > 0 ? (
                    <table className="w-full text-label-12 mb-2">
                      <thead>
                        <tr className="text-faint">
                          <th className="text-left pb-1 text-label-12-strong pr-3">Label</th>
                          <th className="text-left pb-1 text-label-12-strong pr-3">City</th>
                          <th className="text-left pb-1 text-label-12-strong pr-3">Region</th>
                          <th className="text-left pb-1 text-label-12-strong pr-3">Country</th>
                          <th className="text-left pb-1 text-label-12-strong pr-3">Timezone</th>
                          <th className="pb-1"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {project.locations.map((loc) => (
                          <tr key={loc.label} className="border-t border-mono-800/30">
                            <td className="py-1.5 pr-3">
                              <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-1 text-label-12-strong ${loc.label === project.defaultLocation ? 'border-positive-700/60 bg-positive-950/30 text-positive' : 'border-mono-700/60 bg-mono-800/40 text-neutral'}`}>
                                {loc.label}{loc.label === project.defaultLocation ? ' \u2605' : ''}
                              </span>
                            </td>
                            <td className="py-1.5 pr-3 text-neutral">{loc.city}</td>
                            <td className="py-1.5 pr-3 text-neutral">{loc.region}</td>
                            <td className="py-1.5 pr-3 text-neutral">{loc.country}</td>
                            <td className="py-1.5 pr-3 text-muted">{loc.timezone ?? '\u2014'}</td>
                            <td className="py-1.5">
                              <div className="flex items-center gap-1.5">
                                {canChange && loc.label !== project.defaultLocation && (
                                  <button
                                    type="button"
                                    disabled={locationWorking}
                                    onClick={() => { void handleSetDefaultLocation(loc.label) }}
                                    className="text-button-14 text-secondary hover:text-positive-400 transition-colors disabled:opacity-40"
                                    aria-label={`Set ${loc.label} as default search location`}
                                  >
                                    Set default
                                  </button>
                                )}
                                {canChange && (
                                  <button
                                    type="button"
                                    disabled={locationWorking}
                                    onClick={() => { void handleRemoveLocation(loc.label) }}
                                    className="text-button-14 text-secondary hover:text-negative-400 transition-colors disabled:opacity-40"
                                    aria-label={`Remove search location ${loc.label}`}
                                  >
                                    Remove
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="text-muted text-copy-13 mb-2">No search locations configured</p>
                  )}
                  {!canChange ? null : showAddLocation ? (
                    <div className="mt-3 space-y-2">
                      <p className="text-copy-14-strong text-secondary">Add search location</p>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="mb-1 block text-label-14 text-secondary">Label *</label>
                          <input className={inputClass} type="text" value={newLocLabel} onChange={(e) => setNewLocLabel(e.target.value)} placeholder="nyc" />
                        </div>
                        <div>
                          <label className="mb-1 block text-label-14 text-secondary">City *</label>
                          <input className={inputClass} type="text" value={newLocCity} onChange={(e) => setNewLocCity(e.target.value)} placeholder="New York" />
                        </div>
                        <div>
                          <label className="mb-1 block text-label-14 text-secondary">Region *</label>
                          <input className={inputClass} type="text" value={newLocRegion} onChange={(e) => setNewLocRegion(e.target.value)} placeholder="NY" />
                        </div>
                        <div>
                          <label className="mb-1 block text-label-14 text-secondary">Country *</label>
                          <input className={inputClass} type="text" value={newLocCountry} onChange={(e) => setNewLocCountry(e.target.value)} placeholder="US" maxLength={2} />
                        </div>
                        <div className="col-span-2">
                          <label className="mb-1 block text-label-14 text-secondary">Timezone (optional)</label>
                          <input className={inputClass} type="text" value={newLocTimezone} onChange={(e) => setNewLocTimezone(e.target.value)} placeholder="America/New_York" />
                        </div>
                      </div>
                      <div className="flex items-center gap-2 pt-1">
                        <Button type="button" size="sm" disabled={locationWorking || !newLocValid} onClick={asyncHandler(handleAddLocation)}>
                          {locationWorking ? 'Adding...' : 'Add search location'}
                        </Button>
                        <Button type="button" size="sm" variant="outline" disabled={locationWorking} onClick={() => { setShowAddLocation(false); setLocationError(null) }}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button type="button" size="sm" variant="outline" onClick={() => setShowAddLocation(true)}>
                      + Add search location
                    </Button>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
      </section>

      <section className="page-section">
        <div className="section-head">
          <div className="inline-flex items-center">
            <h2>Tracking results</h2>
            <InfoTooltip text="Each exported row is one query and engine result, including the saved answer and source URLs. Includes completed, partial, and failed checks with saved results. Test runs, provider credentials, and raw provider payloads are excluded." />
          </div>
        </div>

        <div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex shrink-0 flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={exportingFormat !== null}
                onClick={asyncHandler(() => handleResultsExport('csv'))}
              >
                {exportingFormat === 'csv' ? 'Preparing CSV...' : 'Download CSV'}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={exportingFormat !== null}
                onClick={asyncHandler(() => handleResultsExport('json'))}
              >
                {exportingFormat === 'json' ? 'Preparing JSON...' : 'Download JSON'}
              </Button>
            </div>
          </div>
          {resultsExportError && (
            <p className="mt-3 rounded border border-negative-800/40 bg-negative-950/20 px-3 py-2 text-copy-14 text-negative">
              {resultsExportError}
            </p>
          )}
        </div>
      </section>
    </>
  )
}
