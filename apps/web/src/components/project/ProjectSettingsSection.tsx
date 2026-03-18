import { useEffect, useState } from 'react'

import { Button } from '../ui/button.js'
import { addLocation, removeLocation, setDefaultLocation, type ApiLocation } from '../../api.js'

export function ProjectSettingsSection({
  project,
  onUpdateProject,
  onRefresh,
}: {
  project: { name: string; displayName: string; canonicalDomain: string; ownedDomains: string[]; country: string; language: string; locations: Array<{ label: string; city: string; region: string; country: string; timezone?: string }>; defaultLocation: string | null }
  onUpdateProject: (projectName: string, updates: { displayName?: string; canonicalDomain?: string; ownedDomains?: string[]; country?: string; language?: string; locations?: Array<{ label: string; city: string; region: string; country: string; timezone?: string }>; defaultLocation?: string | null }) => Promise<void>
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
    setNewDomain('')
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

  async function handleSave() {
    if (!displayName.trim() || !canonicalDomain.trim() || !country.trim() || !language.trim()) return
    setSaving(true)
    setError(null)
    try {
      await onUpdateProject(project.name, {
        displayName: displayName.trim(),
        canonicalDomain: canonicalDomain.trim(),
        ownedDomains,
        country: country.trim(),
        language: language.trim(),
      })
      setEditing(false)
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
    JSON.stringify(ownedDomains) !== JSON.stringify(project.ownedDomains ?? [])

  const inputClass = 'w-full rounded border border-zinc-700 bg-transparent px-2 py-1.5 text-sm text-zinc-200 placeholder-zinc-600 focus:border-zinc-500 focus:outline-none'
  const labelClass = 'block text-xs font-medium text-zinc-400 mb-1'
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
        <div className="mb-3 rounded-lg border border-rose-800/40 bg-rose-950/20 px-3 py-2 text-sm text-rose-300">
          {error}
          <button type="button" className="ml-2 text-rose-400 hover:text-rose-200" onClick={() => setError(null)}>×</button>
        </div>
      )}

      {editing ? (
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 space-y-4">
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
                <span key={d} className="inline-flex items-center gap-1 rounded-full border border-zinc-700/60 bg-zinc-800/40 px-2 py-0.5 text-xs text-zinc-300">
                  {d}
                  <button type="button" className="ml-0.5 text-zinc-500 hover:text-zinc-200 transition-colors" onClick={() => handleRemoveDomain(d)} aria-label={`Remove ${d}`}>×</button>
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

          <div className="flex items-center gap-2 pt-2 border-t border-zinc-800/60">
            <Button type="button" disabled={saving || !hasChanges || !displayName.trim() || !canonicalDomain.trim()} onClick={handleSave}>
              {saving ? 'Saving...' : 'Save changes'}
            </Button>
            <Button type="button" variant="outline" disabled={saving} onClick={handleCancel}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-800/60 bg-zinc-900/30 overflow-hidden">
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b border-zinc-800/40">
                <td className="px-4 py-2.5 text-zinc-500 font-medium w-40">Display name</td>
                <td className="px-4 py-2.5 text-zinc-200">{project.displayName || '\u2014'}</td>
              </tr>
              <tr className="border-b border-zinc-800/40">
                <td className="px-4 py-2.5 text-zinc-500 font-medium">Canonical domain</td>
                <td className="px-4 py-2.5 text-zinc-200">{project.canonicalDomain}</td>
              </tr>
              <tr className="border-b border-zinc-800/40">
                <td className="px-4 py-2.5 text-zinc-500 font-medium">Owned domains</td>
                <td className="px-4 py-2.5">
                  {(project.ownedDomains ?? []).length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {project.ownedDomains.map((d) => (
                        <span key={d} className="rounded-full border border-zinc-700/60 bg-zinc-800/40 px-2 py-0.5 text-xs text-zinc-300">{d}</span>
                      ))}
                    </div>
                  ) : (
                    <span className="text-zinc-500">\u2014</span>
                  )}
                </td>
              </tr>
              <tr className="border-b border-zinc-800/40">
                <td className="px-4 py-2.5 text-zinc-500 font-medium">Country</td>
                <td className="px-4 py-2.5 text-zinc-200">{project.country}</td>
              </tr>
              <tr className="border-b border-zinc-800/40">
                <td className="px-4 py-2.5 text-zinc-500 font-medium">Language</td>
                <td className="px-4 py-2.5 text-zinc-200">{project.language}</td>
              </tr>
              <tr>
                <td className="px-4 py-2.5 text-zinc-500 font-medium align-top pt-3">Locations</td>
                <td className="px-4 py-2.5">
                  {locationError && (
                    <div className="mb-2 rounded border border-rose-800/40 bg-rose-950/20 px-2 py-1 text-xs text-rose-300">
                      {locationError}
                      <button type="button" className="ml-1 text-rose-400 hover:text-rose-200" onClick={() => setLocationError(null)}>×</button>
                    </div>
                  )}
                  {(project.locations ?? []).length > 0 ? (
                    <table className="w-full text-xs mb-2">
                      <thead>
                        <tr className="text-zinc-600">
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
                          <tr key={loc.label} className="border-t border-zinc-800/30">
                            <td className="py-1.5 pr-3">
                              <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${loc.label === project.defaultLocation ? 'border-emerald-700/60 bg-emerald-950/30 text-emerald-300' : 'border-zinc-700/60 bg-zinc-800/40 text-zinc-300'}`}>
                                {loc.label}{loc.label === project.defaultLocation ? ' \u2605' : ''}
                              </span>
                            </td>
                            <td className="py-1.5 pr-3 text-zinc-300">{loc.city}</td>
                            <td className="py-1.5 pr-3 text-zinc-300">{loc.region}</td>
                            <td className="py-1.5 pr-3 text-zinc-300">{loc.country}</td>
                            <td className="py-1.5 pr-3 text-zinc-500">{loc.timezone ?? '\u2014'}</td>
                            <td className="py-1.5">
                              <div className="flex items-center gap-1.5">
                                {loc.label !== project.defaultLocation && (
                                  <button
                                    type="button"
                                    disabled={locationWorking}
                                    onClick={() => handleSetDefaultLocation(loc.label)}
                                    className="text-[10px] text-zinc-500 hover:text-emerald-400 transition-colors disabled:opacity-40"
                                    aria-label={`Set ${loc.label} as default location`}
                                  >
                                    Set default
                                  </button>
                                )}
                                <button
                                  type="button"
                                  disabled={locationWorking}
                                  onClick={() => handleRemoveLocation(loc.label)}
                                  className="text-[10px] text-zinc-500 hover:text-rose-400 transition-colors disabled:opacity-40"
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
                    <p className="text-zinc-500 text-xs mb-2">No locations configured</p>
                  )}
                  {showAddLocation ? (
                    <div className="mt-2 rounded border border-zinc-800 bg-zinc-900/50 p-3 space-y-2">
                      <p className="text-[10px] font-medium uppercase tracking-wide text-zinc-500">Add location</p>
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-[10px] text-zinc-500 mb-0.5">Label *</label>
                          <input className={inputClass} type="text" value={newLocLabel} onChange={(e) => setNewLocLabel(e.target.value)} placeholder="nyc" />
                        </div>
                        <div>
                          <label className="block text-[10px] text-zinc-500 mb-0.5">City *</label>
                          <input className={inputClass} type="text" value={newLocCity} onChange={(e) => setNewLocCity(e.target.value)} placeholder="New York" />
                        </div>
                        <div>
                          <label className="block text-[10px] text-zinc-500 mb-0.5">Region *</label>
                          <input className={inputClass} type="text" value={newLocRegion} onChange={(e) => setNewLocRegion(e.target.value)} placeholder="NY" />
                        </div>
                        <div>
                          <label className="block text-[10px] text-zinc-500 mb-0.5">Country *</label>
                          <input className={inputClass} type="text" value={newLocCountry} onChange={(e) => setNewLocCountry(e.target.value)} placeholder="US" maxLength={2} />
                        </div>
                        <div className="col-span-2">
                          <label className="block text-[10px] text-zinc-500 mb-0.5">Timezone (optional)</label>
                          <input className={inputClass} type="text" value={newLocTimezone} onChange={(e) => setNewLocTimezone(e.target.value)} placeholder="America/New_York" />
                        </div>
                      </div>
                      <div className="flex items-center gap-2 pt-1">
                        <Button type="button" size="sm" disabled={locationWorking || !newLocValid} onClick={handleAddLocation}>
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
