import { useId, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { OPENROUTER_RECOMMENDED_SWEEP_MODELS, describeError, openRouterRouteModel, openRouterRouteName } from '@canonry/canonry-contracts'

import { Button } from '../ui/button.js'

/** The OpenRouter entry of the settings provider catalog: what the picker lists and how it checks a typed model ID. */
export interface OpenRouterPickerCatalog {
  knownModels: readonly { id: string; displayName: string }[]
  modelValidationPattern: { source: string; flags: string }
  modelValidationHint: string
}

/**
 * Common vendors offered as one-click filters, by their OpenRouter ID
 * prefixes. Only vendors with at least one model in the loaded catalog are
 * shown.
 */
const VENDOR_FILTERS = [
  { label: 'OpenAI', prefixes: ['openai/'] },
  { label: 'Google', prefixes: ['google/'] },
  { label: 'Anthropic', prefixes: ['anthropic/'] },
  { label: 'Perplexity', prefixes: ['perplexity/'] },
  { label: 'xAI', prefixes: ['x-ai/'] },
  { label: 'DeepSeek', prefixes: ['deepseek/'] },
  { label: 'Mistral', prefixes: ['mistralai/'] },
  { label: 'Meta', prefixes: ['meta/', 'meta-llama/'] },
] as const

function modelCount(count: number): string {
  return `${count} ${count === 1 ? 'model' : 'models'}`
}

/**
 * Concrete sweep models share the OpenRouter connection, but each remains a
 * separate selection. The picker leads with a few recommended models and keeps
 * OpenRouter's full catalog behind "Browse all", so the common choice takes
 * one click and the long list stays out of the way. Project Answer engines
 * opens it behind "Add models" and stages the chosen routes for "Save
 * engines"; first-sweep setup renders it `inline`, always open, and saves the
 * chosen routes with "Save N models".
 *
 * `onAdd` receives only routes not already in `selected`. When it returns a
 * promise the picker stays busy until it settles and shows a rejection as an
 * error, keeping the choices so the operator can retry.
 */
export function OpenRouterModelPicker({ catalog, selected, onAdd, disabled = false, inline = false }: {
  catalog: OpenRouterPickerCatalog
  selected: readonly string[]
  onAdd: (routes: string[]) => void | Promise<void>
  disabled?: boolean
  inline?: boolean
}) {
  const names = new Map(catalog.knownModels.map(model => [model.id, model.displayName]))
  const recommended = OPENROUTER_RECOMMENDED_SWEEP_MODELS.filter(model => names.has(model.id))
  const catalogEmpty = catalog.knownModels.length === 0
  const [open, setOpen] = useState(false)
  const [browsing, setBrowsing] = useState(recommended.length === 0)
  const [vendor, setVendor] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState<string[]>([])
  const [manual, setManual] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const id = useId()
  const busy = disabled || submitting
  const query = search.trim().toLowerCase()
  const vendors = VENDOR_FILTERS.filter(filter => catalog.knownModels.some(model => filter.prefixes.some(prefix => model.id.startsWith(prefix))))
  const vendorPrefixes = VENDOR_FILTERS.find(filter => filter.label === vendor)?.prefixes ?? []
  const matches = catalog.knownModels
    .filter(model => vendorPrefixes.length === 0 || vendorPrefixes.some(prefix => model.id.startsWith(prefix)))
    .filter(model => `${model.displayName} ${model.id}`.toLowerCase().includes(query))
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
  const candidates = draft.filter(route => !selected.includes(route))
  const candidateNames = candidates.map((route) => {
    const model = openRouterRouteModel(route) ?? route
    return names.get(model) ?? model
  })

  function toggle(route: string, checked: boolean) {
    setDraft(current => (checked ? [...new Set([...current, route])] : current.filter(value => value !== route)))
  }

  function addManual() {
    const model = manual.trim()
    if (!new RegExp(catalog.modelValidationPattern.source, catalog.modelValidationPattern.flags).test(model)) {
      setError(catalog.modelValidationHint)
      return
    }
    let route: string
    try {
      route = openRouterRouteName(model)
    } catch (cause) {
      setError(describeError(cause))
      return
    }
    setDraft(current => [...new Set([...current, route])])
    setManual('')
    setError(null)
  }

  function finish() {
    setDraft([])
    if (!inline) setOpen(false)
  }

  function submit() {
    setError(null)
    const pending = onAdd(candidates)
    if (!(pending instanceof Promise)) {
      finish()
      return
    }
    setSubmitting(true)
    void pending
      .then(finish, (cause: unknown) => { setError(describeError(cause)) })
      .finally(() => { setSubmitting(false) })
  }

  const modelRow = (modelId: string, title: string, detail: string) => {
    const route = openRouterRouteName(modelId)
    const added = selected.includes(route)
    const detailId = `${id}-${modelId}`
    return (
      <label key={modelId} data-model-id={modelId} className="flex min-h-11 items-center gap-3 py-2 text-sm text-secondary">
        <input type="checkbox" aria-label={title} aria-describedby={detailId} checked={added || draft.includes(route)} disabled={added} onChange={event => toggle(route, event.target.checked)} />
        <span className="min-w-0">
          <span className="block text-heading">{title}</span>
          <span id={detailId} className="block break-all text-sm">{detail}</span>
        </span>
        {added && <span className="ml-auto">Added</span>}
      </label>
    )
  }

  const manualEntry = (
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-0 flex-1 text-sm text-secondary">Model ID<input className="setup-input mt-1 w-full" value={manual} placeholder="vendor/model" onChange={event => setManual(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); if (manual.trim()) addManual() } }} /></label>
      <Button type="button" variant="outline" disabled={busy || !manual.trim()} onClick={addManual}>Add ID</Button>
    </div>
  )

  const panel = (
    <div
      id={id}
      role="group"
      aria-label={inline ? 'Choose OpenRouter models' : 'Add OpenRouter models'}
      className={inline ? 'space-y-3' : 'space-y-3 border-y border-default py-3'}
    >
      {catalogEmpty ? (
        <>
          <p className="text-sm text-secondary">
            Couldn't load OpenRouter's model list. Check the OpenRouter key in{' '}
            {/* In the setup wizard a new tab keeps the operator on this step while they fix the key. */}
            <Link to="/settings" className="text-link hover:underline" {...(inline ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>Settings</Link>
            , or enter a model ID below.
          </p>
          {manualEntry}
        </>
      ) : (
        <>
          {recommended.length > 0 && (
            <fieldset disabled={busy} className="divide-y divide-default">
              <legend className="mb-1 text-sm font-medium text-heading">Recommended</legend>
              {recommended.map(model => modelRow(model.id, names.get(model.id) ?? model.id, `From the maker of ${model.engine}`))}
            </fieldset>
          )}
          {recommended.length > 0 && (
            <Button type="button" variant="ghost" size="sm" className="-ml-3 text-sm" aria-expanded={browsing} aria-controls={`${id}-browse`} onClick={() => setBrowsing(value => !value)}>
              {browsing ? 'Hide the full list' : `Browse all OpenRouter models (${catalog.knownModels.length})`}
            </Button>
          )}
          {browsing && (
            <div id={`${id}-browse`} className="space-y-3">
              {vendors.length > 0 && (
                <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by vendor">
                  {vendors.map((filter) => {
                    const active = vendor === filter.label
                    return (
                      <button
                        key={filter.label}
                        type="button"
                        aria-pressed={active}
                        disabled={busy}
                        onClick={() => setVendor(active ? null : filter.label)}
                        className={`filter-chip ${active ? 'filter-chip-active' : ''}`}
                      >
                        {filter.label}
                      </button>
                    )
                  })}
                </div>
              )}
              <label className="block text-sm text-secondary">Search OpenRouter models<input className="setup-input mt-1 w-full" type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
              <fieldset disabled={busy} className="max-h-64 overflow-y-auto divide-y divide-default">
                <legend className="sr-only">OpenRouter models</legend>
                {matches.map(model => modelRow(model.id, model.displayName, model.id))}
                {matches.length === 0 && <p className="py-3 text-sm text-secondary">{search.trim() ? `No models match "${search.trim()}".` : `No ${vendor ?? ''} models in OpenRouter's list.`}</p>}
              </fieldset>
              {manualEntry}
            </div>
          )}
        </>
      )}
      {candidateNames.length > 0 && <p className="break-words text-sm text-secondary">Selected: {candidateNames.join(', ')}</p>}
      {error && <p role="alert" className="text-sm text-negative">{error}</p>}
      <div className="flex gap-2">
        <Button type="button" disabled={busy || candidates.length === 0} onClick={submit}>
          {inline
            ? (submitting ? 'Saving models…' : candidates.length > 0 ? `Save ${modelCount(candidates.length)}` : 'Save models')
            : candidates.length > 0 ? `Add ${modelCount(candidates.length)}` : 'Add selected'}
        </Button>
        {!inline && <Button type="button" variant="outline" onClick={() => setOpen(false)}>Close</Button>}
      </div>
    </div>
  )

  if (inline) return panel
  return <div className="space-y-3">
    <Button type="button" variant="outline" disabled={disabled} aria-expanded={open} aria-controls={id} onClick={() => { setOpen(value => !value); setDraft([]); setError(null) }}>Add models</Button>
    {open && panel}
  </div>
}
