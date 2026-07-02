import { useEffect, useState } from 'react'

import { Button } from '../ui/button.js'
import { addLocation, removeLocation, setDefaultLocation, type ApiLocation } from '../../api.js'
import { addToast } from '../../lib/toast-store.js'
import { asyncHandler } from '../../lib/async-handler.js'

export function ProjectSettingsSection({
  project,
  onUpdateProject,
  onRefresh,
}: {
  project: { name: string; displayName: string; canonicalDomain: string; ownedDomains: string[]; aliases: string[]; country: string; language: string; locations: Array<{ label: string; city: string; region: string; country: string; timezone?: string }>; defaultLocation: string | null }
  onUpdateProject: (projectName: string, updates: { displayName?: string; canonicalDomain?: string; ownedDomains?: string[]; aliases?: string[]; country?: string; language?: string; locations?: Array<{ label: string; city: string; region: string; country: string; timezone?: string }>; defaultLocation?: string | null }) => Promise<void>
  onRefresh: () => void
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
      onRefresh()
      setNewLocLabel('')
      setNewLocCity('')
      setNewLocRegion('')
      setNewLocCountry('')
      setNewLocTimezone('')
      setShowAddLocation(false)
      addToast({
        title: 'Location added',
        detail: `${label} is now available for ${project.name}.`,
        tone: 'positive',
        dedupeKey: `project:location:add:${project.name}:${label}`,
        dedupeMode: 'drop',
      })
    } catch (err) {
      setLocationError(err instanceof Error ? err.message : 'Failed to add location')
    } finally {
      setLocationWorking(false)
    }
  }

  async function handleRemoveLocation(label: string) {
    setLocationWorking(true)
    setLocationError(null)
    try {
      await removeLocation(project.name, label)
      onRefresh()
      addToast({
        title: 'Location removed',
        detail: `${label} was removed from ${project.name}.`,
        tone: 'positive',
        dedupeKey: `project:location:remove:${project.name}:${label}`,
        dedupeMode: 'drop',
      })
    } catch (err) {
      setLocationError(err instanceof Error ? err.message : 'Failed to remove location')
    } finally {
      setLocationWorking(false)
    }
  }

  async function handleSetDefaultLocation(label: string) {
    setLocationWorking(true)
    setLocationError(null)
    try {
      await setDefaultLocation(project.name, label)
      onRefresh()
      addToast({
        title: 'Default location updated',
        detail: `${label} is now the default for ${project.name}.`,
        tone: 'positive',
        dedupeKey: `project:location:default:${project.name}`,
        dedupeMode: 'replace',
      })
    } catch (err) {
      setLocationError(err instanceof Error ? err.message : 'Failed to set default location')
    } finally {
      setLocationWorking(false)
    }
  }

  const hasChanges = displayName !== project.displayName ||
    canonicalDomain !== project.canonicalDomain ||
    country !== project.country ||
    language !== project.language ||
    JSON.stringify(ownedDomains) !== JSON.stringify(project.ownedDomains ?? []) ||
    JSON.stringify(aliases) !== JSON.stringify(project.aliases ?? [])

  const inputClass = 'w-full rounded border border-strong bg-transparent px-2 py-1.5 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none'
  const labelClass = 'block text-xs font-medium text-secondary mb-1'
  const newLocValid = newLocLabel.trim() && newLocCity.trim() && newLocRegion.trim() && newLocCountry.trim()

  return (
    <section className="page-section-divider">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Configuration</p>
          <h2>Project settings</h2>
        </div>
        {!editing && (
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            Edit settings
          </Button>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-negative-800/40 bg-negative-950/20 px-3 py-2 text-sm text-negative">
          {error}
          <button type="button" className="ml-2 text-negative-400 hover:text-negative-200" onClick={() => setError(null)}>×</button>
        </div>
      )}

      {editing ? (
        <div className="rounded-lg border border-base bg-bg-elevated/40 p-4 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>Display name</label>
              <input className={inputClass} type="text" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="My Project" />
            </div>
            <div>
              <label className={labelClass}>Canonical domain</label>
              <input className={inputClass} type="text" value={canonicalDomain} onChange={(e) => setCanonicalDomain(e.target.value)} placeholder="example.com" />
            </div>
            <div>
              <label className={labelClass}>Country</label>
              <input className={inputClass} type="text" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="US" maxLength={2} />
            </div>
            <div>
              <label className={labelClass}>Language</label>
              <input className={inputClass} type="text" value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="en" />
            </div>
          </div>

          <div>
            <label className={labelClass}>Owned domains</label>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {ownedDomains.map((d) => (
                <span key={d} className="inline-flex items-center gap-1 rounded-full border border-mono-700/60 bg-mono-800/40 px-2 py-0.5 text-xs text-neutral">
                  {d}
                  <button type="button" className="ml-0.5 text-muted hover:text-strong transition-colors" onClick={() => handleRemoveDomain(d)} aria-label={`Remove ${d}`}>×</button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
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
            <label className={labelClass}>Aliases</label>
            <p className="text-[11px] text-muted mb-1.5">
              Additional brand names checked against LLM answer text. Use for product names,
              prior names, or DBAs (e.g. add "Meta" as an alias to facebook.com).
            </p>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {aliases.map((a) => (
                <span key={a} className="inline-flex items-center gap-1 rounded-full border border-mono-700/60 bg-mono-800/40 px-2 py-0.5 text-xs text-neutral">
                  {a}
                  <button type="button" className="ml-0.5 text-muted hover:text-strong transition-colors" onClick={() => handleRemoveAlias(a)} aria-label={`Remove ${a}`}>×</button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
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
        <div className="rounded-lg border border-default bg-surface overflow-hidden">
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b border-subtle">
                <td className="px-4 py-2.5 text-muted font-medium w-40">Display name</td>
                <td className="px-4 py-2.5 text-strong">{project.displayName || '\u2014'}</td>
              </tr>
              <tr className="border-b border-subtle">
                <td className="px-4 py-2.5 text-muted font-medium">Canonical domain</td>
                <td className="px-4 py-2.5 text-strong">{project.canonicalDomain}</td>
              </tr>
              <tr className="border-b border-subtle">
                <td className="px-4 py-2.5 text-muted font-medium">Owned domains</td>
                <td className="px-4 py-2.5">
                  {(project.ownedDomains ?? []).length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {project.ownedDomains.map((d) => (
                        <span key={d} className="rounded-full border border-mono-700/60 bg-mono-800/40 px-2 py-0.5 text-xs text-neutral">{d}</span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-muted">{'\u2014'}</span>
                  )}
                </td>
              </tr>
              <tr className="border-b border-subtle">
                <td className="px-4 py-2.5 text-muted font-medium">Aliases</td>
                <td className="px-4 py-2.5">
                  {(project.aliases ?? []).length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {project.aliases.map((a) => (
                        <span key={a} className="rounded-full border border-mono-700/60 bg-mono-800/40 px-2 py-0.5 text-xs text-neutral">{a}</span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-muted">{'\u2014'}</span>
                  )}
                </td>
              </tr>
              <tr className="border-b border-subtle">
                <td className="px-4 py-2.5 text-muted font-medium">Country</td>
                <td className="px-4 py-2.5 text-strong">{project.country}</td>
              </tr>
              <tr className="border-b border-subtle">
                <td className="px-4 py-2.5 text-muted font-medium">Language</td>
                <td className="px-4 py-2.5 text-strong">{project.language}</td>
              </tr>
              <tr>
                <td className="px-4 py-2.5 text-muted font-medium align-top pt-3">Locations</td>
                <td className="px-4 py-2.5">
                  {locationError && (
                    <div className="mb-2 rounded border border-negative-800/40 bg-negative-950/20 px-2 py-1 text-xs text-negative">
                      {locationError}
                      <button type="button" className="ml-1 text-negative-400 hover:text-negative-200" onClick={() => setLocationError(null)}>×</button>
                    </div>
                  )}
                  {(project.locations ?? []).length > 0 ? (
                    <table className="w-full text-xs mb-2">
                      <thead>
                        <tr className="text-faint">
                          <th className="text-left pb-1 font-medium pr-3">Label</th>
                          <th className="text-left pb-1 font-medium pr-3">City</th>
                          <th className="text-left pb-1 font-medium pr-3">Region</th>
                          <th className="text-left pb-1 font-medium pr-3">Country</th>
                          <th className="text-left pb-1 font-medium pr-3">Timezone</th>
                          <th className="pb-1"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {project.locations.map((loc) => (
                          <tr key={loc.label} className="border-t border-mono-800/30">
                            <td className="py-1.5 pr-3">
                              <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${loc.label === project.defaultLocation ? 'border-positive-700/60 bg-positive-950/30 text-positive' : 'border-mono-700/60 bg-mono-800/40 text-neutral'}`}>
                                {loc.label}{loc.label === project.defaultLocation ? ' \u2605' : ''}
                              </span>
                            </td>
                            <td className="py-1.5 pr-3 text-neutral">{loc.city}</td>
                            <td className="py-1.5 pr-3 text-neutral">{loc.region}</td>
                            <td className="py-1.5 pr-3 text-neutral">{loc.country}</td>
                            <td className="py-1.5 pr-3 text-muted">{loc.timezone ?? '\u2014'}</td>
                            <td className="py-1.5">
                              <div className="flex items-center gap-1.5">
                                {loc.label !== project.defaultLocation && (
                                  <button
                                    type="button"
                                    disabled={locationWorking}
                                    onClick={() => { void handleSetDefaultLocation(loc.label) }}
                                    className="text-[10px] text-muted hover:text-positive-400 transition-colors disabled:opacity-40"
                                    aria-label={`Set ${loc.label} as default location`}
                                  >
                                    Set default
                                  </button>
                                )}
                                <button
                                  type="button"
                                  disabled={locationWorking}
                                  onClick={() => { void handleRemoveLocation(loc.label) }}
                                  className="text-[10px] text-muted hover:text-negative-400 transition-colors disabled:opacity-40"
                                  aria-label={`Remove location ${loc.label}`}
                                >
                                  Remove
                                </button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <p className="text-muted text-xs mb-2">No locations configured</p>
                  )}
                  {showAddLocation ? (
                    <div className="mt-2 rounded border border-base bg-bg-elevated/50 p-3 space-y-2">
                      <p className="text-[10px] font-medium uppercase tracking-wide text-muted">Add location</p>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[10px] text-muted mb-0.5">Label *</label>
                          <input className={inputClass} type="text" value={newLocLabel} onChange={(e) => setNewLocLabel(e.target.value)} placeholder="nyc" />
                        </div>
                        <div>
                          <label className="block text-[10px] text-muted mb-0.5">City *</label>
                          <input className={inputClass} type="text" value={newLocCity} onChange={(e) => setNewLocCity(e.target.value)} placeholder="New York" />
                        </div>
                        <div>
                          <label className="block text-[10px] text-muted mb-0.5">Region *</label>
                          <input className={inputClass} type="text" value={newLocRegion} onChange={(e) => setNewLocRegion(e.target.value)} placeholder="NY" />
                        </div>
                        <div>
                          <label className="block text-[10px] text-muted mb-0.5">Country *</label>
                          <input className={inputClass} type="text" value={newLocCountry} onChange={(e) => setNewLocCountry(e.target.value)} placeholder="US" maxLength={2} />
                        </div>
                        <div className="col-span-2">
                          <label className="block text-[10px] text-muted mb-0.5">Timezone (optional)</label>
                          <input className={inputClass} type="text" value={newLocTimezone} onChange={(e) => setNewLocTimezone(e.target.value)} placeholder="America/New_York" />
                        </div>
                      </div>
                      <div className="flex items-center gap-2 pt-1">
                        <Button type="button" size="sm" disabled={locationWorking || !newLocValid} onClick={asyncHandler(handleAddLocation)}>
                          {locationWorking ? 'Adding...' : 'Add location'}
                        </Button>
                        <Button type="button" size="sm" variant="outline" disabled={locationWorking} onClick={() => { setShowAddLocation(false); setLocationError(null) }}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button type="button" size="sm" variant="outline" onClick={() => setShowAddLocation(true)}>
                      + Add location
                    </Button>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
