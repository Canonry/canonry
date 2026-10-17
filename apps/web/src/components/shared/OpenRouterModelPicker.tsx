import { useId, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { describeError, openRouterRouteModel, openRouterRouteName } from '@canonry/canonry-contracts'

import { Button } from '../ui/button.js'

/** The OpenRouter entry of the settings provider catalog: what the picker lists and how it checks a typed model ID. */
export interface OpenRouterPickerCatalog {
  knownModels: readonly { id: string; displayName: string }[]
  modelValidationPattern: { source: string; flags: string }
  modelValidationHint: string
}

/**
 * Common vendors offered as one-click filters, by their OpenRouter ID prefix.
 * Only vendors with at least one model in the loaded catalog are shown.
 */
const VENDOR_FILTERS = [
  { label: 'OpenAI', prefix: 'openai/' },
  { label: 'Google', prefix: 'google/' },
  { label: 'Anthropic', prefix: 'anthropic/' },
  { label: 'Perplexity', prefix: 'perplexity/' },
  { label: 'xAI', prefix: 'x-ai/' },
  { label: 'DeepSeek', prefix: 'deepseek/' },
  { label: 'Mistral', prefix: 'mistralai/' },
  { label: 'Meta', prefix: 'meta-llama/' },
] as const

function modelCount(count: number): string {
  return `${count} ${count === 1 ? 'model' : 'models'}`
}

/**
 * Concrete sweep models share the OpenRouter connection, but each remains a
 * separate selection. Project Answer engines opens it behind "Add models" and
 * stages the chosen routes for "Save engines"; first-sweep setup renders it
 * `inline`, always open, and saves the chosen routes with "Save models".
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
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [draft, setDraft] = useState<string[]>([])
  const [manual, setManual] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const id = useId()
  const busy = disabled || submitting
  const query = search.trim().toLowerCase()
  const catalogEmpty = catalog.knownModels.length === 0
  const vendors = VENDOR_FILTERS.filter(vendor => catalog.knownModels.some(model => model.id.startsWith(vendor.prefix)))
  const matches = catalog.knownModels.filter(model => `${model.displayName} ${model.id}`.toLowerCase().includes(query))
  const candidates = draft.filter(route => !selected.includes(route))

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

  const panel = (
    <div
      id={id}
      role="group"
      aria-label={inline ? 'Choose OpenRouter models' : 'Add OpenRouter models'}
      className={inline ? 'space-y-3' : 'space-y-3 border-y border-default py-3'}
    >
      {catalogEmpty ? (
        <p className="text-sm text-secondary">
          Couldn't load OpenRouter's model list. Check the OpenRouter key in{' '}
          {/* In the setup wizard a new tab keeps the operator on this step while they fix the key. */}
          <Link to="/settings" className="text-link hover:underline" {...(inline ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>Settings</Link>
          , or enter a model ID below.
        </p>
      ) : (
        <>
          {vendors.length > 0 && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by vendor">
              {vendors.map(vendor => {
                const active = search === vendor.prefix
                return (
                  <button
                    key={vendor.prefix}
                    type="button"
                    aria-pressed={active}
                    disabled={busy}
                    onClick={() => setSearch(active ? '' : vendor.prefix)}
                    className={`filter-chip ${active ? 'filter-chip-active' : ''}`}
                  >
                    {vendor.label}
                  </button>
                )
              })}
            </div>
          )}
          <label className="block text-sm text-secondary">Search OpenRouter models<input className="setup-input mt-1 w-full" type="search" value={search} onChange={event => setSearch(event.target.value)} /></label>
          <fieldset disabled={busy} className="max-h-64 overflow-y-auto divide-y divide-default">
            <legend className="sr-only">OpenRouter models</legend>
            {matches.map(model => {
              const route = openRouterRouteName(model.id)
              const added = selected.includes(route)
              return <label key={model.id} className="flex min-h-11 items-center gap-3 py-2 text-sm text-secondary"><input type="checkbox" aria-label={`${model.displayName} ${model.id}`} checked={added || draft.includes(route)} disabled={added} onChange={event => setDraft(current => event.target.checked ? [...current, route] : current.filter(value => value !== route))} /><span className="min-w-0"><span className="block text-heading">{model.displayName}</span><span className="block break-all text-sm">{model.id}</span></span>{added && <span className="ml-auto">Added</span>}</label>
            })}
            {matches.length === 0 && <p className="py-3 text-sm text-secondary">{`No models match "${search.trim()}".`}</p>}
          </fieldset>
        </>
      )}
      <div className="flex flex-wrap items-end gap-2"><label className="min-w-0 flex-1 text-sm text-secondary">Model ID<input className="setup-input mt-1 w-full" value={manual} placeholder="vendor/model" onChange={event => setManual(event.target.value)} /></label><Button type="button" variant="outline" disabled={busy || !manual.trim()} onClick={addManual}>Include model ID</Button></div>
      {draft.filter(route => !catalog.knownModels.some(model => openRouterRouteName(model.id) === route)).map(route => <p key={route} className="break-all text-sm text-secondary">{openRouterRouteModel(route)} selected</p>)}
      {error && <p role="alert" className="text-sm text-negative">{error}</p>}
      <div className="flex gap-2">
        <Button type="button" disabled={busy || candidates.length === 0} onClick={submit}>
          {inline ? (submitting ? 'Saving models…' : 'Save models') : `Add ${modelCount(candidates.length)}`}
        </Button>
        {!inline && <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>}
      </div>
    </div>
  )

  if (inline) return panel
  return <div className="space-y-3">
    <Button type="button" variant="outline" disabled={disabled} aria-expanded={open} aria-controls={id} onClick={() => { setOpen(value => !value); setDraft([]); setError(null) }}>Add models</Button>
    {open && panel}
  </div>
}
