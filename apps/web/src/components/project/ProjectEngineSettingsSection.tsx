import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'

import { fetchSettings, isEmbed, type ApiProject } from '../../api.js'
import { Button } from '../ui/button.js'

type EngineProject = Pick<ApiProject, 'name' | 'providers' | 'providerModels'>
type EngineSave = Pick<ApiProject, 'providers' | 'providerModels'>

function copyModels(models: Record<string, string> | undefined): Record<string, string> {
  return { ...(models ?? {}) }
}

function sameModels(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b))
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b))
  return leftEntries.length === rightEntries.length && leftEntries.every(([provider, model], index) => {
    const other = rightEntries[index]
    return other?.[0] === provider && other[1] === model
  })
}

/**
 * Project-scoped provider selection and model inheritance. Kept apart from
 * metadata settings because a provider/model edit changes future execution,
 * not a project’s identity.
 */
export function ProjectEngineSettingsSection({
  project,
  onSave,
}: {
  project: EngineProject
  onSave: (next: EngineSave) => Promise<void>
}) {
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings, staleTime: 60_000 })
  const [automatic, setAutomatic] = useState(project.providers.length === 0)
  const [selected, setSelected] = useState<string[]>(project.providers)
  const [models, setModels] = useState<Record<string, string>>(() => copyModels(project.providerModels))
  const [saved, setSaved] = useState<EngineSave>({ providers: project.providers, providerModels: copyModels(project.providerModels) })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const customInput = useRef<HTMLInputElement>(null)

  const catalog = settings.data?.providerCatalog ?? []
  const configured = useMemo(
    () => new Set((settings.data?.providers ?? []).filter(provider => provider.configured).map(provider => provider.name)),
    [settings.data],
  )
  const rows = useMemo(() => {
    const known = new Map(catalog.map(entry => [entry.name, entry]))
    for (const provider of Object.keys(models)) {
      if (!known.has(provider)) {
        known.set(provider, {
          name: provider,
          displayName: provider,
          mode: 'api' as const,
          modelConfigurable: true,
          defaultModel: '',
          knownModels: [],
          modelValidationPattern: { source: '.', flags: '' },
          modelValidationHint: 'Validate this custom model ID with the server.',
        })
      }
    }
    return [...known.values()].sort((a, b) => a.displayName.localeCompare(b.displayName))
  }, [catalog, models])
  const hasModelChange = !sameModels(models, saved.providerModels)

  useEffect(() => {
    if (saving) return
    const next = { providers: project.providers, providerModels: copyModels(project.providerModels) }
    setSaved(next)
    setAutomatic(next.providers.length === 0)
    setSelected(next.providers)
    setModels(next.providerModels)
  }, [project])

  function chooseEngines() {
    setAutomatic(false)
    // Preserve a previous explicit draft during this edit session. First entry
    // materializes from the currently configured catalogue.
    if (selected.length === 0) setSelected([...configured])
  }

  function setModel(provider: string, value: string) {
    setModels(current => {
      const next = { ...current }
      if (value === '__inherit__') delete next[provider]
      else if (value === '__custom__') next[provider] = next[provider] ?? ''
      else next[provider] = value
      return next
    })
    if (value === '__custom__') queueMicrotask(() => customInput.current?.focus())
  }

  function toggleProvider(provider: string, checked: boolean) {
    setSelected(current => checked ? [...new Set([...current, provider])] : current.filter(name => name !== provider))
  }

  function cancel() {
    setAutomatic(saved.providers.length === 0)
    setSelected(saved.providers)
    setModels(copyModels(saved.providerModels))
    setError(null)
    setNotice(null)
  }

  async function save() {
    if (settings.isError || settings.isLoading || (!automatic && selected.length === 0)) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      const next = { providers: automatic ? [] : selected, providerModels: models }
      await onSave(next)
      setSaved({ providers: [...next.providers], providerModels: copyModels(next.providerModels) })
      setNotice('Engine settings saved. They apply on the next sweep.')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setSaving(false)
    }
  }

  if (isEmbed()) return null
  if (settings.isLoading) {
    return <section className="project-engine-settings" aria-busy="true"><p role="status" className="text-sm text-secondary">Loading engine settings…</p></section>
  }
  if (settings.isError) {
    return (
      <section className="project-engine-settings">
        <h2>Answer engines</h2>
        <p role="alert" className="text-sm text-negative-400">Could not load the engine catalogue. Saving is disabled until it is available.</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void settings.refetch()}>Retry</Button>
      </section>
    )
  }
  if (catalog.length === 0) {
    return (
      <section className="project-engine-settings">
        <h2>Answer engines</h2>
        <p role="alert" className="text-sm text-negative-400">The engine catalogue is incomplete. Saving is disabled so existing project overrides cannot be cleared.</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void settings.refetch()}>Retry</Button>
      </section>
    )
  }
  if (configured.size === 0) {
    return <section className="project-engine-settings"><h2>Answer engines</h2><p className="text-sm text-secondary">Configure an answer engine in <Link to="/settings" className="text-link">global Settings</Link> before choosing project engines.</p></section>
  }

  return (
    <section className="project-engine-settings" aria-busy={saving}>
      <div className="section-head section-head-inline">
        <div><p className="eyebrow eyebrow-soft">Execution</p><h2>Answer engines</h2></div>
        <p className="supporting-copy">Changes apply on the next sweep.</p>
      </div>
      <fieldset disabled={saving} className="project-engine-fieldset">
        <legend>Provider mode</legend>
        <label><input type="radio" checked={automatic} onChange={() => setAutomatic(true)} /> All configured engines</label>
        <p className="project-engine-help">Includes engines configured later in global Settings.</p>
        <label><input type="radio" checked={!automatic} onChange={chooseEngines} /> Choose engines</label>
        {!automatic && (
          <div className="project-engine-list">
            {rows.map(provider => {
              const checked = selected.includes(provider.name)
              const configuredNow = configured.has(provider.name)
              const stale = checked && !configuredNow
              const model = models[provider.name]
              const known = provider.knownModels.some(item => item.id === model)
              const selectValue = model === undefined ? '__inherit__' : known ? model : '__custom__'
              return (
                <div key={provider.name} className="project-engine-row">
                  <label className="project-engine-provider"><input type="checkbox" checked={checked} disabled={!configuredNow && !checked} onChange={event => toggleProvider(provider.name, event.target.checked)} /> <span>{provider.displayName}</span>{stale && <span className="text-xs text-caution-400">Not configured, skipped</span>}</label>
                  {checked && (provider.modelConfigurable ? (
                    <div className="project-engine-model">
                      <label htmlFor={`project-model-${provider.name}`}>Model</label>
                      <select id={`project-model-${provider.name}`} value={selectValue} onChange={event => setModel(provider.name, event.target.value)}>
                        <option value="__inherit__">Use instance setting: {provider.defaultModel || 'default'}</option>
                        {provider.knownModels.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}
                        <option value="__custom__">Custom model ID…</option>
                      </select>
                      {selectValue === '__custom__' && <input ref={customInput} aria-label={`${provider.displayName} custom model ID`} value={model ?? ''} onChange={event => setModels(current => ({ ...current, [provider.name]: event.target.value }))} aria-describedby={`project-model-hint-${provider.name}`} />}
                      <p id={`project-model-hint-${provider.name}`} className="project-engine-help">{model ? 'Project override' : 'Inherited from instance settings'}. {provider.modelValidationHint}</p>
                    </div>
                  ) : <p className="project-engine-help">Model is detected/fixed for this browser engine.</p>)}
                </div>
              )
            })}
          </div>
        )}
      </fieldset>
      {!automatic && selected.length === 0 && <p role="alert" className="text-sm text-negative-400">Choose at least one configured engine.</p>}
      {error && <p role="alert" className="text-sm text-negative-400">{error}</p>}
      {notice && <p role="status" className="text-sm text-positive-400">{notice}</p>}
      {hasModelChange && <p className="project-engine-warning">Applies on the next sweep. Existing history remains visible. If the recorded model changes, month-to-month comparison may exclude that engine.</p>}
      <div className="flex gap-2"><Button type="button" onClick={() => void save()} disabled={saving || (!automatic && selected.length === 0)}>{saving ? 'Saving engines…' : 'Save engines'}</Button><Button type="button" variant="outline" onClick={cancel} disabled={saving}>Cancel</Button></div>
    </section>
  )
}
