import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { EngineRouteConfig } from '@ainyc/canonry-api-client'

import { fetchSettings, isEmbed, type ApiProject } from '../../api.js'
import { Button } from '../ui/button.js'
import { describeError } from '@ainyc/canonry-contracts'
import { useAccount } from '../../contexts/account-context.js'
import { EngineRoutesReadOnlySummary } from '../settings/EngineRoutesSettings.js'

type EngineProject = Pick<ApiProject, 'name' | 'providers' | 'providerModels'> & {
  /** Optional while old dashboard payloads continue to omit this preference. */
  researchProvider?: string | null
}
type EngineSave = Pick<ApiProject, 'providers' | 'providerModels'> & {
  researchProvider?: string | null
}

type EngineRow = {
  /** The ID used by this UI. Native rows use their legacy provider ID. */
  id: string
  displayName: string
  kind: 'native' | 'verified' | 'text-only'
  sweepEligible: boolean
  connectionMissing?: boolean
  /** Only native providers may use legacy project model overrides. */
  nativeProvider?: string
  modelConfigurable: boolean
  defaultModel: string
  knownModels: Array<{ id: string; displayName: string }>
  modelValidationHint: string
}

type ResearchRoute = Pick<EngineRouteConfig, 'id' | 'label' | 'source' | 'capabilities'> & {
  unavailable?: boolean
}

function copyModels(models: Record<string, string> | undefined): Record<string, string> {
  const copy: Record<string, string> = {}
  for (const [provider, model] of Object.entries(models ?? {})) {
    const legacyProvider = legacyProviderId(provider)
    // Prefer a current plain provider key if a transitional native-prefixed
    // key and the legacy key somehow coexist in one saved project.
    if (!Object.hasOwn(copy, legacyProvider) || provider === legacyProvider) {
      copy[legacyProvider] = model
    }
  }
  return copy
}

function sameModels(left: Record<string, string>, right: Record<string, string>): boolean {
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b))
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b))
  return leftEntries.length === rightEntries.length && leftEntries.every(([provider, model], index) => {
    const other = rightEntries[index]
    return other[0] === provider && other[1] === model
  })
}

function legacyProviderId(routeOrProvider: string): string {
  if (!routeOrProvider.startsWith('native:')) return routeOrProvider
  const provider = routeOrProvider.slice('native:'.length)
  return provider || routeOrProvider
}

function normalizeSweepProviders(providers: readonly string[]): string[] {
  return [...new Set(providers.map(legacyProviderId))]
}

function normalizeResearchProvider(provider: string | null | undefined): string | null {
  return provider ? legacyProviderId(provider) : null
}

function engineRowOrder(row: EngineRow): number {
  if (row.kind === 'native') return 0
  if (row.kind === 'verified') return 1
  return 2
}

function researchRouteOrder(route: ResearchRoute): number {
  if (route.source === 'implicit-native') return 0
  if (route.source === 'verified-adapter') return 1
  return 2
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
  const { canWrite } = useAccount()
  const embedded = isEmbed()
  const settings = useQuery({
    queryKey: ['settings'],
    queryFn: fetchSettings,
    staleTime: 60_000,
    enabled: canWrite && !embedded,
  })
  const [automatic, setAutomatic] = useState(project.providers.length === 0)
  const [selected, setSelected] = useState<string[]>(() => normalizeSweepProviders(project.providers))
  const [models, setModels] = useState<Record<string, string>>(() => copyModels(project.providerModels))
  const [researchProvider, setResearchProvider] = useState<string | null>(() => normalizeResearchProvider(project.researchProvider))
  const [researchTouched, setResearchTouched] = useState(false)
  const [saved, setSaved] = useState<EngineSave>(() => ({
    providers: normalizeSweepProviders(project.providers),
    providerModels: copyModels(project.providerModels),
    ...(project.researchProvider !== undefined ? { researchProvider: normalizeResearchProvider(project.researchProvider) } : {}),
  }))
  const [saving, setSaving] = useState(false)
  // Once the operator has touched the form, background dashboard refetches (which
  // hand down a fresh `project` object identity even when the data is unchanged)
  // must not reset their in-progress edits — mirror ProjectSettingsSection's
  // `editing` guard.
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const customInput = useRef<HTMLInputElement>(null)

  const catalog = settings.data?.providerCatalog ?? []
  const engineRoutes = settings.data?.engineRoutes ?? []
  const configured = useMemo(
    () => new Set((settings.data?.providers ?? []).filter(provider => provider.configured).map(provider => provider.name)),
    [settings.data],
  )
  const connectionIds = useMemo(
    () => new Set((settings.data?.engineConnections ?? []).map(connection => connection.id)),
    [settings.data],
  )
  const rows = useMemo<EngineRow[]>(() => {
    const known = new Map<string, EngineRow>()
    const nativeRoutes = new Map(
      engineRoutes
        .filter(route => route.source === 'implicit-native' && route.id.startsWith('native:'))
        .map(route => [legacyProviderId(route.id), route]),
    )
    for (const provider of catalog) {
      const route = nativeRoutes.get(provider.name)
      known.set(provider.name, {
        id: provider.name,
        displayName: route?.label ?? provider.displayName,
        kind: 'native',
        sweepEligible: configured.has(provider.name),
        nativeProvider: provider.name,
        modelConfigurable: provider.modelConfigurable,
        defaultModel: provider.defaultModel,
        knownModels: provider.knownModels,
        modelValidationHint: provider.modelValidationHint,
      })
    }
    for (const [provider, route] of nativeRoutes) {
      if (known.has(provider)) continue
      known.set(provider, {
        id: provider,
        displayName: route.label,
        kind: 'native',
        sweepEligible: configured.has(provider),
        nativeProvider: provider,
        modelConfigurable: false,
        defaultModel: route.modelId,
        knownModels: [],
        modelValidationHint: 'This native route does not expose a project model override.',
      })
    }
    for (const route of engineRoutes) {
      if (route.source === 'implicit-native') continue
      const textOnly = route.capabilities.kind === 'text-only'
      const connectionMissing = !connectionIds.has(route.connectionId)
      known.set(route.id, {
        id: route.id,
        displayName: route.label,
        kind: textOnly ? 'text-only' : 'verified',
        sweepEligible: !textOnly && !connectionMissing,
        connectionMissing,
        modelConfigurable: false,
        defaultModel: route.modelId,
        knownModels: [],
        modelValidationHint: textOnly
          ? 'Text-only routes are available through the separate research route selector.'
          : 'The verified route owns its measured model and evidence contract.',
      })
    }
    for (const legacyProvider of [...Object.keys(models), ...selected.map(legacyProviderId)]) {
      if (known.has(legacyProvider) || legacyProvider.startsWith('route:')) continue
      known.set(legacyProvider, {
        id: legacyProvider,
        displayName: legacyProvider,
        kind: 'native',
        sweepEligible: configured.has(legacyProvider),
        nativeProvider: legacyProvider,
        modelConfigurable: true,
        defaultModel: '',
        knownModels: [],
        modelValidationHint: 'Validate this saved custom model ID with the server.',
      })
    }
    return [...known.values()].sort((left, right) => (
      engineRowOrder(left) - engineRowOrder(right) || left.displayName.localeCompare(right.displayName)
    ))
  }, [catalog, configured, connectionIds, engineRoutes, models, selected])
  const researchRoutes = useMemo<ResearchRoute[]>(() => {
    const routes: ResearchRoute[] = engineRoutes.map(route => ({
      id: route.source === 'implicit-native' ? legacyProviderId(route.id) : route.id,
      label: route.label,
      source: route.source,
      capabilities: route.capabilities,
      unavailable: route.source === 'implicit-native'
        ? !configured.has(legacyProviderId(route.id))
        : !connectionIds.has(route.connectionId),
    }))
    if (researchProvider && !routes.some(route => route.id === researchProvider)) {
      routes.push({
        id: researchProvider,
        label: researchProvider,
        source: 'configured',
        capabilities: { kind: 'text-only' },
        unavailable: true,
      })
    }
    return routes.sort((left, right) => (
      researchRouteOrder(left) - researchRouteOrder(right) || left.label.localeCompare(right.label)
    ))
  }, [configured, connectionIds, engineRoutes, researchProvider])
  const selectableSweepIds = new Set(rows.filter(row => row.sweepEligible).map(row => row.id))
  const selectedSweepIds = selected.filter(id => selectableSweepIds.has(id))
  const staleVerifiedIds = selected.filter(id => rows.some(row => row.id === id && row.kind === 'verified' && !row.sweepEligible))
  const selectedNativeProviders = new Set(
    rows
      .filter(row => row.nativeProvider && selectedSweepIds.includes(row.id))
      .map(row => row.nativeProvider!),
  )
  const hasModelChange = !sameModels(models, saved.providerModels)

  useEffect(() => {
    // Re-sync from the prop only on a genuine project change, and never while the
    // operator is mid-edit — a background dashboard refetch hands down a fresh
    // `project` identity with unchanged data, and resetting then would wipe the
    // in-progress selection. `editing`/`saving` are intentionally read but not in
    // the dep list: their transitions must not themselves trigger a re-sync.
    if (saving || editing) return
    const next: EngineSave = {
      providers: normalizeSweepProviders(project.providers),
      providerModels: copyModels(project.providerModels),
      ...(project.researchProvider !== undefined ? { researchProvider: normalizeResearchProvider(project.researchProvider) } : {}),
    }
    setSaved(next)
    setAutomatic(next.providers.length === 0)
    setSelected(next.providers)
    setModels(next.providerModels)
    setResearchProvider(normalizeResearchProvider(project.researchProvider))
    setResearchTouched(false)
  }, [project])

  function chooseEngines() {
    setEditing(true)
    setAutomatic(false)
    // Preserve a previous explicit draft during this edit session. Automatic
    // mode has always meant native configured providers; verified dynamic routes
    // are opt-in so adding one never broadens an existing project's sweeps.
    if (selectedSweepIds.length === 0) setSelected(rows.filter(row => row.kind === 'native' && row.sweepEligible).map(row => row.id))
  }

  function setModel(provider: string, value: string, currentIsKnown = false) {
    setEditing(true)
    setModels(current => {
      const next = { ...current }
      if (value === '__inherit__') delete next[provider]
      // Switching to custom from a known catalog id must actually enter custom
      // mode. Keeping the known id would make `selectValue` recompute back to it,
      // so the custom input would never render — clear it to an empty draft.
      else if (value === '__custom__') next[provider] = currentIsKnown ? '' : (next[provider] ?? '')
      else next[provider] = value
      return next
    })
    if (value === '__custom__') queueMicrotask(() => customInput.current?.focus())
  }

  function toggleProvider(provider: string, checked: boolean) {
    setEditing(true)
    setSelected(current => checked ? [...new Set([...current, provider])] : current.filter(name => name !== provider))
  }

  function cancel() {
    setEditing(false)
    setAutomatic(saved.providers.length === 0)
    setSelected(saved.providers)
    setModels(copyModels(saved.providerModels))
    setResearchProvider(saved.researchProvider ?? null)
    setResearchTouched(false)
    setError(null)
    setNotice(null)
  }

  async function save() {
    if (settings.isError || settings.isLoading || (!automatic && selectedSweepIds.length === 0 && staleVerifiedIds.length === 0)) return
    setSaving(true)
    setError(null)
    setNotice(null)
    try {
      // Model overrides belong only to legacy native providers. A selected
      // verified route owns its evidence-qualified model; text-only routes are
      // never allowed into sweep providers at all.
      const providerModels = Object.fromEntries(
        Object.entries(models).filter(([provider, model]) =>
          model.trim() !== '' && (automatic
            ? !provider.startsWith('route:') && !provider.startsWith('native:')
            : selectedNativeProviders.has(provider)),
      ))
      const providers = automatic
        ? []
        : [...selectedSweepIds, ...staleVerifiedIds]
          .map(selectionId => rows.find(row => row.id === selectionId)?.nativeProvider ?? selectionId)
      const next: EngineSave = {
        providers: [...new Set(providers)],
        providerModels,
        // Do not echo an untouched saved route: it may have become unavailable
        // after the project last loaded, and the server deliberately preserves
        // that stale preference until the operator explicitly replaces it.
        ...(researchTouched ? { researchProvider } : {}),
      }
      await onSave(next)
      setSaved({
        providers: [...next.providers],
        providerModels: copyModels(next.providerModels),
        ...(next.researchProvider !== undefined
          ? { researchProvider: next.researchProvider }
          : (saved.researchProvider !== undefined ? { researchProvider: saved.researchProvider } : {})),
      })
      setEditing(false)
      setResearchTouched(false)
      setNotice('Engine settings saved. They apply to future work.')
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setSaving(false)
    }
  }

  if (embedded) return null
  if (!canWrite) return <EngineRoutesReadOnlySummary />
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
  if (catalog.length === 0 && engineRoutes.length === 0) {
    return (
      <section className="project-engine-settings">
        <h2>Answer engines</h2>
        <p role="alert" className="text-sm text-negative-400">The engine catalogue is incomplete. Saving is disabled so existing project overrides cannot be cleared.</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void settings.refetch()}>Retry</Button>
      </section>
    )
  }
  return (
    <section className="project-engine-settings" aria-busy={saving}>
      <div className="section-head section-head-inline">
        <div><p className="eyebrow eyebrow-soft">Execution</p><h2>Answer engines</h2></div>
        <p className="supporting-copy">Changes apply to future sweeps and research.</p>
      </div>
      <fieldset disabled={saving} className="project-engine-fieldset">
        <legend>Sweep routes</legend>
        <label><input type="radio" checked={automatic} onChange={() => { setEditing(true); setAutomatic(true) }} /> All configured engines</label>
        <p className="project-engine-help">Includes configured native engines added later in global Settings.</p>
        <label><input type="radio" checked={!automatic} onChange={chooseEngines} /> Choose engines</label>
        {!automatic && (
          <div className="project-engine-list">
            {rows.map(route => {
              const checked = selected.includes(route.id)
              const unavailable = checked && !route.sweepEligible
              const model = route.nativeProvider ? models[route.nativeProvider] : undefined
              const known = route.knownModels.some(item => item.id === model)
              const selectValue = model === undefined ? '__inherit__' : known ? model : '__custom__'
              return (
                <div key={route.id} className="project-engine-row">
                  <div>
                    <label className="project-engine-provider"><input type="checkbox" checked={checked} disabled={!route.sweepEligible && !checked} onChange={event => toggleProvider(route.id, event.target.checked)} /> <span>{route.displayName}</span></label>
                    {route.kind === 'text-only' && <p className="project-engine-help text-caution-400">Text-only — research only</p>}
                    {route.connectionMissing && <p className="project-engine-help text-caution-400">Connection missing</p>}
                    {unavailable && route.kind === 'native' && <p className="project-engine-help text-caution-400">Not configured, skipped</p>}
                  </div>
                  {checked && route.nativeProvider && (route.modelConfigurable ? (
                    <div className="project-engine-model">
                      <label htmlFor={`project-model-${route.id}`}>Model</label>
                      <select id={`project-model-${route.id}`} value={selectValue} onChange={event => setModel(route.nativeProvider!, event.target.value, known)}>
                        <option value="__inherit__">Use instance setting: {route.defaultModel || 'default'}</option>
                        {route.knownModels.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}
                        <option value="__custom__">Custom model ID…</option>
                      </select>
                      {selectValue === '__custom__' && <input ref={customInput} aria-label={`${route.displayName} custom model ID`} value={model ?? ''} onChange={event => { setEditing(true); setModels(current => ({ ...current, [route.nativeProvider!]: event.target.value })) }} aria-describedby={`project-model-hint-${route.id}`} />}
                      <p id={`project-model-hint-${route.id}`} className="project-engine-help">{model ? 'Project override' : 'Inherited from instance settings'}. {route.modelValidationHint}</p>
                    </div>
                  ) : <p className="project-engine-help">{route.kind === 'verified' ? 'Model and evidence are fixed by this verified route.' : 'Model is detected/fixed for this browser engine.'}</p>)}
                </div>
              )
            })}
          </div>
        )}
      </fieldset>
      {rows.every(route => !route.sweepEligible) && <p className="mt-3 text-sm text-secondary">Configure an answer engine in <Link to="/settings" className="text-link">global Settings</Link> before choosing a sweep route. Research can still use a configured text-only route below.</p>}
      {!automatic && selectedSweepIds.length === 0 && staleVerifiedIds.length === 0 && <p role="alert" className="text-sm text-negative-400">Choose at least one available sweep route.</p>}
      {researchRoutes.length > 0 && (
        <div className="mt-5 border-t border-default pt-4">
          <label className="text-sm font-medium text-secondary" htmlFor="project-research-route">Research route</label>
          <select id="project-research-route" className="mt-1 w-full max-w-xl rounded-md border border-base bg-surface px-2 py-1.5 text-sm text-primary" value={researchProvider ?? ''} onChange={event => {
            setEditing(true)
            setResearchTouched(true)
            setResearchProvider(event.target.value || null)
          }}>
            <option value="">Use the default research route</option>
            {researchRoutes.map(route => <option key={route.id} value={route.id} disabled={route.unavailable}>{route.label}{route.capabilities.kind === 'text-only' ? ' — text-only' : ''}{route.unavailable ? ' — unavailable' : ''}</option>)}
          </select>
          <p className="mt-1 project-engine-help">Text-only routes are allowed for research. They cannot run answer-visibility sweeps.</p>
          {researchRoutes.find(route => route.id === researchProvider)?.unavailable && <p className="mt-1 project-engine-help text-caution-400">The saved research route is unavailable because its connection is missing. Choose another route to replace it.</p>}
        </div>
      )}
      {error && <p role="alert" className="text-sm text-negative-400">{error}</p>}
      {notice && <p role="status" className="text-sm text-positive-400">{notice}</p>}
      {hasModelChange && <p className="project-engine-warning">Applies on the next sweep. Existing history remains visible. If the recorded model changes, month-to-month comparison may exclude that engine.</p>}
      <div className="flex gap-2"><Button type="button" onClick={() => void save()} disabled={saving || (!automatic && selectedSweepIds.length === 0 && staleVerifiedIds.length === 0)}>{saving ? 'Saving engines…' : 'Save engines'}</Button><Button type="button" variant="outline" onClick={cancel} disabled={saving}>Cancel</Button></div>
    </section>
  )
}
