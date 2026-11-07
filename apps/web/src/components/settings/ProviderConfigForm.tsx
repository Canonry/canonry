import { useEffect, useId, useRef, useState, type ReactNode, type ComponentProps } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import * as Dialog from '@radix-ui/react-dialog'
import { describeError, isOpenRouterRoute, ProviderKinds, ProviderNames, ProviderQuotaFields, type ProviderCatalogEntryDto, type ProviderConnectionSettingsDto, type ProviderQuotaField, type ProviderSettingsUpdateRequest } from '@canonry/canonry-contracts'

import { Button } from '../ui/button.js'
import { disconnectProvider, fetchProviderConnection, fetchSettings, reloadProviderConnections, updateProviderConfig } from '../../api.js'
import { useUnsavedChanges } from '../../hooks/use-unsaved-changes.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { addToast } from '../../lib/toast-store.js'
import { asyncHandler } from '../../lib/async-handler.js'
import { invalidateProjectQueryDomain } from '../../queries/query-invalidation.js'
import { providerDisplayName } from '../../lib/visibility-trend-helpers.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'

/** Existing connections use the same revision, reset, and limit controls in setup and Settings. */
export function ProviderConfigForm(props: ComponentProps<typeof NewProviderConfigForm> & { configured?: boolean; onCancel?: () => void }) {
  const queryClient = useQueryClient()
  const providerName = props.providerName.toLowerCase()
  const connection = useQuery({
    queryKey: ['settings', 'provider-connection', providerName],
    queryFn: () => fetchProviderConnection(providerName),
    enabled: props.configured === true,
    staleTime: 0,
    retry: false,
  })
  if (!props.configured) return <NewProviderConfigForm {...props} />
  if (connection.isPending) return <p role="status" className="text-copy-14 text-secondary">Loading connection…</p>
  if (connection.isError) return <div className="space-y-3"><p role="alert" className="text-copy-14 text-negative">{describeError(connection.error)}</p><Button type="button" variant="outline" onClick={() => { void connection.refetch() }}>Retry loading connection</Button></div>
  return <div className="space-y-3">
    {props.leadingField}
    <ProviderConnectionEditor
      key={`${connection.data.name}:${connection.data.revision}`}
      compact={props.compact}
      connection={connection.data}
      onDirtyChange={props.onDirtyChange ?? (() => {})}
      onBusyChange={props.onBusyChange ?? (() => {})}
      onCancel={props.onCancel ?? props.onSaved}
      onSaved={async () => {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['settings'] }),
          invalidateProjectQueryDomain(queryClient, 'runAdmission'),
        ])
        addToast({ title: 'Connection saved', detail: 'Your next check will verify access.', tone: 'positive' })
        props.onSaved()
      }}
    />
    {props.secondaryActions}
  </div>
}

function NewProviderConfigForm({ providerName, keyUrl, modelHint, kind, compact = false, offerFreeTier = true, leadingField, secondaryActions, onSaved, onDirtyChange, onBusyChange }: {
  providerName: string
  keyUrl?: string
  modelHint?: string
  /** A routed connection (gateway or answer service) takes no connection model; projects pick routes. */
  kind?: 'answer-engine' | 'model-gateway' | 'answer-service'
  /** Keep optional tuning out of the first-run provider connection path. */
  compact?: boolean
  /** Lead the compact Gemini form with its free tier. Off once another provider is connected. */
  offerFreeTier?: boolean
  /** An adjacent provider selector for the compact connection form. */
  leadingField?: ReactNode
  /** Keep connection actions together in the compact form footer. */
  secondaryActions?: ReactNode
  onSaved: () => void
  onDirtyChange?: (dirty: boolean) => void
  onBusyChange?: (busy: boolean) => void
}) {
  const queryClient = useQueryClient()
  const isLocal = providerName.toLowerCase() === 'local'
  const isOpenRouter = providerName.toLowerCase() === 'openrouter'
  const routedConnection = isOpenRouter || kind === 'model-gateway' || kind === 'answer-service'
  const showGeminiFreeTier = compact && offerFreeTier && providerName.toLowerCase() === 'gemini' && !!keyUrl
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [maxConcurrency, setMaxConcurrency] = useState('')
  const [maxPerMinute, setMaxPerMinute] = useState('')
  const [maxPerDay, setMaxPerDay] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const canSave = isLocal ? baseUrl.trim().length > 0 : apiKey.trim().length > 0
  const dirty = Boolean(apiKey || baseUrl || model || maxConcurrency || maxPerMinute || maxPerDay)
  useEffect(() => { onDirtyChange?.(dirty) }, [dirty, onDirtyChange])

  async function handleSave() {
    if (!canSave) return
    setSaving(true)
    onBusyChange?.(true)
    setError(null)
    setSuccess(false)
    try {
      const parseQuotaField = (s: string): number | undefined => {
        const n = parseInt(s.trim(), 10)
        return Number.isFinite(n) && n > 0 ? n : undefined
      }
      const quota: { maxConcurrency?: number; maxRequestsPerMinute?: number; maxRequestsPerDay?: number } = {}
      const maxConcurrencyVal = parseQuotaField(maxConcurrency)
      if (maxConcurrencyVal !== undefined) quota.maxConcurrency = maxConcurrencyVal
      const maxPerMinuteVal = parseQuotaField(maxPerMinute)
      if (maxPerMinuteVal !== undefined) quota.maxRequestsPerMinute = maxPerMinuteVal
      const maxPerDayVal = parseQuotaField(maxPerDay)
      if (maxPerDayVal !== undefined) quota.maxRequestsPerDay = maxPerDayVal
      await updateProviderConfig(providerName.toLowerCase(), {
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
        ...(model.trim() ? { model: model.trim() } : {}),
        ...(Object.keys(quota).length > 0 ? { quota } : {}),
      })
      setApiKey('')
      setBaseUrl('')
      setModel('')
      setMaxConcurrency('')
      setMaxPerMinute('')
      setMaxPerDay('')
      setSuccess(true)
      // A new key, model or endpoint lifts that provider's hold on every
      // project, so their notices and sweep buttons must not wait for staleness.
      void invalidateProjectQueryDomain(queryClient, 'runAdmission')
      // The model catalog is read with the saved credential, so a corrected key
      // must reach any open model picker now, not after the settings read goes stale.
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
      addToast({
        title: 'Provider updated',
        detail: `${providerName} configuration saved.`,
        tone: 'positive',
        dedupeKey: `settings:provider:${providerName}`,
        dedupeMode: 'replace',
      })
      onSaved()
    } catch (err) {
      setError(describeError(err))
    } finally {
      setSaving(false)
      onBusyChange?.(false)
    }
  }

  const modelPlaceholder = modelHint ?? 'Use default model'
  const labelClassName = compact ? 'block text-label-14-strong text-secondary' : 'text-label-14 text-secondary'
  const inputClassName = compact
    ? 'setup-input min-h-11 w-full'
    : 'mt-0.5 w-full rounded border border-strong bg-transparent px-2 py-1.5 text-label-14 text-strong placeholder-mono-400 focus:border-mono-500 focus:outline-none'

  const optionalFields = (
    <>
      {!routedConnection && <div className={compact ? 'space-y-1.5' : undefined}>
        <label className={labelClassName} htmlFor={`model-${providerName}`}>Model (optional)</label>
        <input
          id={`model-${providerName}`}
          type="text"
          className={inputClassName}
          placeholder={modelPlaceholder}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
      </div>}
      <div>
        <label className={labelClassName}>Quota (optional)</label>
        <div className="mt-0.5 grid grid-cols-3 gap-1.5">
          <div>
            <input
              type="number"
              min="1"
              className={compact ? 'setup-input min-h-11 w-full' : 'w-full rounded border border-strong bg-transparent px-2 py-1.5 text-label-14 text-strong placeholder-mono-400 focus:border-mono-500 focus:outline-none'}
              placeholder="Concurrent"
              value={maxConcurrency}
              onChange={(e) => setMaxConcurrency(e.target.value)}
            />
            <p className="mt-1 text-copy-14 text-secondary">Max concurrent</p>
          </div>
          <div>
            <input
              type="number"
              min="1"
              className={compact ? 'setup-input min-h-11 w-full' : 'w-full rounded border border-strong bg-transparent px-2 py-1.5 text-label-14 text-strong placeholder-mono-400 focus:border-mono-500 focus:outline-none'}
              placeholder="/min"
              value={maxPerMinute}
              onChange={(e) => setMaxPerMinute(e.target.value)}
            />
            <p className="mt-1 text-copy-14 text-secondary">Per minute</p>
          </div>
          <div>
            <input
              type="number"
              min="1"
              className={compact ? 'setup-input min-h-11 w-full' : 'w-full rounded border border-strong bg-transparent px-2 py-1.5 text-label-14 text-strong placeholder-mono-400 focus:border-mono-500 focus:outline-none'}
              placeholder="/day"
              value={maxPerDay}
              onChange={(e) => setMaxPerDay(e.target.value)}
            />
            <p className="mt-1 text-copy-14 text-secondary">Per day</p>
          </div>
        </div>
      </div>
    </>
  )

  const localEndpointField = isLocal ? (
    <div className={compact ? 'space-y-1.5' : undefined}>
      <label className={labelClassName} htmlFor={`base-url-${providerName}`}>Base URL</label>
      <input
        id={`base-url-${providerName}`}
        type="text"
        className={inputClassName}
        placeholder="http://localhost:11434/v1"
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
      />
      <p className="mt-1 text-copy-14 text-secondary">Use any OpenAI-compatible endpoint, such as Ollama or vLLM.</p>
    </div>
  ) : null
  const apiKeyField = (
    <div className={compact ? 'min-w-0 space-y-1.5' : undefined}>
      <div className={compact ? 'flex items-center justify-between gap-3' : 'flex items-center justify-between'}>
        <span className="flex items-center gap-2">
          <label className={labelClassName} htmlFor={`api-key-${providerName}`}>
            API key{isLocal ? ' (optional)' : ''}
          </label>
          {isOpenRouter && <InfoTooltip text="OpenRouter bills your account for each answer, including its web search. An AI Visibility check asks every query once per model." />}
        </span>
        {keyUrl && !showGeminiFreeTier && (
          <a
            href={keyUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-label-14 text-secondary hover:text-neutral underline underline-offset-2"
          >
            Get API key {'\u2197'}
          </a>
        )}
      </div>
      <input
        id={`api-key-${providerName}`}
        type="password"
        autoComplete="new-password"
        autoCapitalize="none"
        spellCheck={false}
        className={inputClassName}
        placeholder={isLocal ? 'Optional. Most local servers do not need one.' : `Enter ${providerDisplayName(providerName)} API key`}
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
      />
    </div>
  )
  const saveButton = (
    <Button type="button" size={compact ? 'default' : 'sm'} className={compact ? 'pointer-coarse:min-h-11' : undefined} disabled={!canSave || saving} onClick={asyncHandler(handleSave)}>
      {saving ? 'Saving...' : compact ? 'Save connection' : 'Save'}
    </Button>
  )

  return (
    <div className={compact ? 'space-y-3' : 'mt-3 space-y-2'}>
      {showGeminiFreeTier && (
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3 pb-2">
          <div className="min-w-0 flex-1 basis-72 space-y-1">
            <h3 className="text-heading-16 text-heading">Connect Gemini</h3>
            <p className="max-w-prose text-copy-14 text-secondary">
              Get a key in Google AI Studio. Free usage depends on the model and your account.{' '}
              <a href="https://ai.google.dev/gemini-api/docs/pricing" target="_blank" rel="noopener noreferrer" className="text-link underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2">
                Pricing and limits
              </a>
            </p>
          </div>
          <Button variant="outline" className="pointer-coarse:min-h-11" asChild>
            <a href={keyUrl} target="_blank" rel="noopener noreferrer">
              Get Gemini API key {'\u2197'}
            </a>
          </Button>
        </div>
      )}
      {compact ? (
        <>
          <div className={leadingField ? 'grid items-start gap-3 sm:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]' : undefined}>
            {leadingField}
            {apiKeyField}
          </div>
          {localEndpointField}
        </>
      ) : <>{localEndpointField}{apiKeyField}</>}
      {compact ? (
        <details>
          <summary className="min-h-11 cursor-pointer text-label-14 text-secondary py-3">Advanced provider settings</summary>
          <div className="space-y-3 pt-2">{optionalFields}</div>
        </details>
      ) : optionalFields}
      {error && <p role="alert" className="text-copy-14 text-negative-400">{error}</p>}
      {success && <p className="text-copy-14 text-positive-400">Provider updated.</p>}
      {compact ? <div className="flex flex-wrap items-center gap-2">{saveButton}{secondaryActions}</div> : saveButton}
    </div>
  )
}

const quotaFields: { key: ProviderQuotaField; label: string }[] = [
  { key: ProviderQuotaFields.maxConcurrency, label: 'Concurrent requests' },
  { key: ProviderQuotaFields.maxRequestsPerMinute, label: 'Requests per minute' },
  { key: ProviderQuotaFields.maxRequestsPerDay, label: 'Requests per day' },
]

function ProviderConnectionEditor({ connection, catalog, compact = false, onDirtyChange, onBusyChange, onSaved, onCancel }: {
  connection: ProviderConnectionSettingsDto
  compact?: boolean
  catalog?: ProviderCatalogEntryDto
  onDirtyChange: (dirty: boolean) => void
  onBusyChange: (busy: boolean) => void
  onSaved: () => Promise<void>
  onCancel: () => void
}) {
  const id = useId()
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [baseUrl, setBaseUrl] = useState(connection.baseUrl ?? '')
  const [inheritEndpoint, setInheritEndpoint] = useState(connection.capabilities.resetBaseUrl && connection.baseUrl === null)
  const [model, setModel] = useState(connection.model ?? '')
  const [inheritModel, setInheritModel] = useState(connection.model === null)
  const [quota, setQuota] = useState(() => Object.fromEntries(quotaFields.map(({ key }) => [key, String(connection.quota.overrides[key] ?? connection.quota.defaults[key])])))
  const [inherited, setInherited] = useState(() => new Set(quotaFields.filter(({ key }) => connection.quota.overrides[key] === undefined).map(({ key }) => key)))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const capabilities = connection.capabilities
  const batchPending = connection.blockers.some(blocker => blocker.code === 'outstanding-batches')
  const dirty = apiKey.trim() !== '' || clearKey
    || (inheritEndpoint ? connection.baseUrl !== null : baseUrl.trim() !== (connection.baseUrl ?? ''))
    || (inheritModel ? connection.model !== null : model.trim() !== (connection.model ?? '') || connection.model === null)
    || quotaFields.some(({ key }) => inherited.has(key) ? connection.quota.overrides[key] !== undefined : Number(quota[key]) !== connection.quota.overrides[key])

  useEffect(() => { onDirtyChange(dirty) }, [dirty, onDirtyChange])

  async function save() {
    if (!dirty || saving) return
    const body: ProviderSettingsUpdateRequest = { expectedRevision: connection.revision }
    const reset: NonNullable<ProviderSettingsUpdateRequest['reset']> = {}
    if (capabilities.apiKey && apiKey.trim()) body.apiKey = apiKey.trim()
    if (capabilities.clearApiKey && clearKey) reset.apiKey = true
    if (capabilities.resetBaseUrl && inheritEndpoint && connection.baseUrl !== null) reset.baseUrl = true
    else if (capabilities.baseUrl && !inheritEndpoint && baseUrl.trim() !== (connection.baseUrl ?? '')) body.baseUrl = baseUrl.trim()
    if (capabilities.model) {
      if (inheritModel && connection.model !== null) reset.model = true
      else if (!inheritModel && model.trim() !== connection.model) body.model = model.trim()
    }
    if (capabilities.quota) {
      const changes: NonNullable<ProviderSettingsUpdateRequest['quota']> = {}
      const resets: ProviderQuotaField[] = []
      for (const { key } of quotaFields) {
        if (inherited.has(key)) { if (connection.quota.overrides[key] !== undefined) resets.push(key) }
        else if (Number(quota[key]) !== connection.quota.overrides[key]) changes[key] = Number(quota[key])
      }
      if (Object.keys(changes).length) body.quota = changes
      if (resets.length) reset.quota = resets
    }
    if (Object.keys(reset).length) body.reset = reset
    setSaving(true)
    onBusyChange(true)
    setError(null)
    try {
      await updateProviderConfig(connection.name, body)
      // A successful write must clear the secret even if the follow-up read fails.
      setApiKey('')
      onDirtyChange(false)
      await onSaved()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setSaving(false)
      onBusyChange(false)
    }
  }

  return <form className={compact ? "space-y-4" : "mt-4 space-y-5 border-t border-default pt-4"} aria-label={`${connection.displayName} connection settings`} aria-busy={saving} onSubmit={event => { event.preventDefault(); void save() }}>
    {connection.blockers.map(blocker => <p key={blocker.code} role="status" className="text-copy-14 text-caution-400">{blocker.message}</p>)}
    <fieldset disabled={saving} className="space-y-5">
      {(capabilities.apiKey || connection.apiKeyConfigured) && <div className="max-w-xl space-y-2">
        <label htmlFor={`${id}-key`} className="block text-label-14 text-heading">{connection.apiKeyConfigured ? 'Replace API key' : 'API key'}</label>
        {capabilities.apiKey ? <input id={`${id}-key`} className="setup-input w-full" type="password" autoComplete="new-password" value={apiKey} disabled={clearKey || batchPending} onChange={event => setApiKey(event.target.value)} placeholder={connection.apiKeyConfigured ? 'Leave blank to keep the saved key' : 'Enter API key'} /> : <p className="text-copy-14 text-secondary">Managed on the host.</p>}
        <p className="text-copy-14 text-secondary">{connection.apiKeyConfigured ? 'Saved key. Access is verified when you run a check.' : 'No API key is saved.'}{catalog?.keyUrl && <> <a className="text-link" href={catalog.keyUrl} target="_blank" rel="noreferrer">Get an API key</a></>}</p>
        {capabilities.clearApiKey && connection.apiKeyConfigured && <label className="flex items-center gap-2 text-label-14 text-secondary"><input type="checkbox" checked={clearKey} disabled={batchPending} onChange={event => { setClearKey(event.target.checked); setApiKey('') }} />Remove the saved API key</label>}
      </div>}
      {(capabilities.baseUrl || connection.baseUrl) && <details open={connection.name === ProviderNames.local || connection.baseUrl !== null} className="max-w-xl">
        <summary className="cursor-pointer text-label-14 text-heading">Endpoint</summary>
        <div className="mt-3 space-y-2">
          {capabilities.resetBaseUrl && <label className="flex items-center gap-2 text-label-14 text-secondary"><input type="checkbox" checked={inheritEndpoint} disabled={batchPending} onChange={event => setInheritEndpoint(event.target.checked)} />Use provider default endpoint</label>}
          {!inheritEndpoint && <><label htmlFor={`${id}-endpoint`} className="block text-label-14 text-heading">Endpoint URL</label><input id={`${id}-endpoint`} className="setup-input w-full" type="url" value={baseUrl} required disabled={!capabilities.baseUrl || batchPending} onChange={event => setBaseUrl(event.target.value)} placeholder={connection.name === ProviderNames.local ? 'http://localhost:11434/v1' : 'https://api.example.com/v1'} /></>}
          <p className="text-copy-14 text-secondary">{connection.name === ProviderNames.local ? 'Use the OpenAI-compatible base URL, including its API path. A key is optional for a local endpoint.' : 'Override only when your provider uses a custom API endpoint.'}</p>
        </div>
      </details>}
      {capabilities.model && <details open={!compact || undefined} className="max-w-xl space-y-2">
        <summary className="cursor-pointer text-label-14 text-heading">{connection.kind === ProviderKinds['model-gateway'] ? 'Text generation model' : 'Instance model'}{compact ? `: ${connection.model ?? connection.defaultModel ?? 'Provider default'}` : ''}</summary>
        <label className="flex items-center gap-2 text-label-14 text-secondary"><input type="checkbox" checked={inheritModel} disabled={batchPending} onChange={event => setInheritModel(event.target.checked)} />Use provider default{connection.defaultModel ? `: ${connection.defaultModel}` : ''}</label>
        {!inheritModel && <><label htmlFor={`${id}-model`} className="sr-only">Model ID</label><input id={`${id}-model`} className="setup-input w-full" list={`${id}-models`} value={model} required disabled={batchPending} onChange={event => setModel(event.target.value)} placeholder={connection.defaultModel ?? 'Model ID'} /><datalist id={`${id}-models`}>{catalog?.knownModels.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</datalist></>}
        <p className="text-copy-14 text-secondary">{connection.kind === ProviderKinds['model-gateway'] ? 'Used by text generation features that inherit the connection model. Project routes keep their selected model.' : 'Projects inherit this model unless they choose an override.'}{catalog?.modelValidationHint ? ` ${catalog.modelValidationHint}` : ''}</p>
      </details>}
      {capabilities.quota && <details>
        <summary className="cursor-pointer text-label-14 text-heading">Request limits</summary>
        <p className="mt-2 text-copy-14 text-secondary">Shared by projects using this connection. Provider defaults stay inherited when they change.</p>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">{quotaFields.map(({ key, label }) => <div key={key} className="space-y-2">
          <label htmlFor={`${id}-${key}`} className="block text-label-14 text-heading">{label}</label>
          <input id={`${id}-${key}`} className="setup-input w-full" type="number" min="1" step="1" required disabled={inherited.has(key)} value={inherited.has(key) ? connection.quota.defaults[key] : quota[key]} onChange={event => setQuota(current => ({ ...current, [key]: event.target.value }))} />
          <label className="flex items-center gap-2 text-label-12 text-secondary"><input type="checkbox" checked={inherited.has(key)} onChange={event => setInherited(current => { const next = new Set(current); if (event.target.checked) next.add(key); else next.delete(key); return next })} />Use default ({connection.quota.defaults[key]})</label>
        </div>)}</div>
        <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={() => setInherited(new Set(quotaFields.map(field => field.key)))}>Reset all limits to defaults</Button>
      </details>}
      {(connection.hostManaged.vertex || connection.hostManaged.batch || connection.hostManaged.pricing || connection.hostUses.length > 0) && <details>
        <summary className="cursor-pointer text-label-14 text-heading">Managed on the host</summary>
        <p className="mt-2 text-copy-14 text-secondary">Update these settings in the host configuration, then reload connections.</p>
        <dl className="definition-list mt-3">
          {connection.hostManaged.vertex && <><div><dt>Vertex project</dt><dd>{connection.hostManaged.vertex.project}</dd></div><div><dt>Region</dt><dd>{connection.hostManaged.vertex.region ?? 'Provider default'}</dd></div><div><dt>Credentials</dt><dd>{connection.hostManaged.vertex.credentialsConfigured ? 'Configured' : 'Application default credentials'}</dd></div></>}
          {connection.hostManaged.batch && <><div><dt>Batch processing</dt><dd>{connection.hostManaged.batch.enabled ? 'Enabled' : 'Disabled'}</dd></div>{connection.hostManaged.batch.maxRequestsPerBatch && <div><dt>Requests per batch</dt><dd>{connection.hostManaged.batch.maxRequestsPerBatch}</dd></div>}{connection.hostManaged.batch.deadlineHours && <div><dt>Batch deadline</dt><dd>{connection.hostManaged.batch.deadlineHours} hours</dd></div>}</>}
          {connection.hostUses.map(use => <div key={use}><dt>Host usage</dt><dd>{use}</dd></div>)}
        </dl>
        {connection.hostManaged.pricing && <details className="mt-3"><summary className="cursor-pointer text-label-14 text-secondary">Model pricing overrides</summary><pre className="mt-2 overflow-auto text-label-12-mono text-secondary">{JSON.stringify(connection.hostManaged.pricing, null, 2)}</pre></details>}
      </details>}
      {error && <p role="alert" className="text-copy-14 text-negative-400">{error}</p>}
      <div className="flex flex-wrap items-center gap-2"><Button type="submit" disabled={!dirty}>{saving ? 'Saving…' : 'Save connection'}</Button><Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>{dirty && <span className="text-label-12 text-secondary">Unsaved changes</span>}</div>
    </fieldset>
  </form>
}

export function ProviderConnectionsSection({ projects }: { projects: { name: string; displayName?: string | null; providers: string[] }[] }) {
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: ['settings'], queryFn: fetchSettings, staleTime: 60_000 })
  const [adding, setAdding] = useState(() => window.location.hash.startsWith('#provider-'))
  const [fallbackEditing, setFallbackEditing] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState<ProviderConnectionSettingsDto | null>(null)
  const connectionActions = useRef(new Map<string, HTMLButtonElement>())
  const addProviderAction = useRef<HTMLButtonElement | null>(null)
  const returnFocusToConnection = useRef<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [disconnecting, setDisconnecting] = useState<ProviderConnectionSettingsDto | null>(null)
  const [disconnectError, setDisconnectError] = useState<string | null>(null)
  const [projectName, setProjectName] = useState('')
  const guard = useUnsavedChanges(dirty, busy)
  const connections = settings.data?.providerConnections
  const selectedProject = projectName || projects[0]?.name
  const selectedModels = projects.find(project => project.name === selectedProject)?.providers.filter(isOpenRouterRoute) ?? []

  useEffect(() => {
    if (editing || busy || returnFocusToConnection.current === null) return
    const action = connectionActions.current.get(returnFocusToConnection.current) ?? addProviderAction.current
    returnFocusToConnection.current = null
    action?.focus()
  }, [editing, busy])

  function closeEditor() {
    returnFocusToConnection.current = editing?.name ?? null
    setEditing(null)
    setDirty(false)
  }

  async function refresh() {
    await queryClient.invalidateQueries({ queryKey: ['settings'] })
    void invalidateProjectQueryDomain(queryClient, 'runAdmission')
  }

  async function openEditor(name: string) {
    setBusy(true)
    setError(null)
    try {
      const connection = await fetchProviderConnection(name)
      setEditing(connection)
      setAdding(false)
      setDirty(false)
    } catch (cause) { setError(describeError(cause)) }
    finally { setBusy(false) }
  }

  async function previewDisconnect(name: string) {
    setEditing(null)
    setDirty(false)
    setBusy(true)
    setError(null)
    setDisconnectError(null)
    try { setDisconnecting(await fetchProviderConnection(name)) }
    catch (cause) { setError(describeError(cause)) }
    finally { setBusy(false) }
  }

  async function disconnect() {
    if (!disconnecting) return
    setBusy(true)
    setDisconnectError(null)
    try {
      await disconnectProvider(disconnecting.name, disconnecting.impactRevision)
      setDisconnecting(null)
      addToast('Connection removed. Project selections and history are retained.', 'positive')
      await refresh()
    } catch (cause) { setDisconnectError(describeError(cause)) }
    finally { setBusy(false) }
  }

  async function reload() {
    setEditing(null)
    setDirty(false)
    setBusy(true)
    setError(null)
    try {
      await reloadProviderConnections()
      await refresh()
      addToast('Connections reloaded from the host', 'positive')
    } catch (cause) { setError(describeError(cause)) }
    finally { setBusy(false) }
  }

  function projectSelection(name: string, kind?: ProviderConnectionSettingsDto['kind']) {
    return <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      {projects.length > 1 && <label className="shrink-0 text-label-14 text-secondary">Project <select className="setup-input ml-2" value={selectedProject} onChange={event => setProjectName(event.target.value)}>{projects.map(project => <option key={project.name} value={project.name}>{project.displayName ?? project.name}</option>)}</select></label>}
      {selectedProject && name === ProviderNames.openrouter && <p className="min-w-0 flex-1 basis-64 break-words text-copy-14 text-secondary"><span className="sr-only">Selected models: </span>{selectedModels.length > 0 ? selectedModels.map(model => providerDisplayName(model, settings.data?.providerCatalog)).join(' · ') : 'No models selected'}</p>}
      {selectedProject ? <Link className="shrink-0 text-label-14 text-link" to="/projects/$projectName/settings" params={{ projectName: selectedProject }} hash="answer-engines">{kind === ProviderKinds['answer-service'] ? 'Choose project profiles' : 'Choose project models'}</Link> : <Link className="text-label-14 text-link" to="/setup">Create a project</Link>}
    </div>
  }

  function connectionRow(connection: ProviderConnectionSettingsDto) {
    const catalog = settings.data?.providerCatalog?.find(entry => entry.name === connection.name)
    const routed = connection.kind !== ProviderKinds['answer-engine']
    const active = editing?.name === connection.name
    const managed = !connection.capabilities.apiKey && !connection.capabilities.baseUrl
    return <div key={connection.name} id={`provider-${connection.name}`} className="scroll-mt-24 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-copy-14-strong text-heading">{connection.displayName}</p>
          <p className="mt-1 break-words text-copy-14 text-secondary">{connection.mode === 'browser' ? 'Browser connection' : connection.kind === ProviderKinds['model-gateway'] ? 'Model gateway' : connection.kind === ProviderKinds['answer-service'] ? 'Search answer service · choose profiles in each project' : connection.effectiveModel ?? 'Direct answer engine'}{connection.baseUrl ? ` · ${connection.baseUrl}` : ''}</p>
          {connection.usage.projectCount > 0 && <p className="mt-1 text-label-12 text-secondary">Used by {connection.usage.projectCount} {connection.usage.projectCount === 1 ? 'project' : 'projects'}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ToneBadge tone={connection.configured ? 'neutral' : 'caution'}>{connection.configured ? 'Configured' : 'Not configured'}</ToneBadge>
          {managed && connection.mode !== 'browser' && <span className="text-label-12 text-secondary">Host managed</span>}
          {connection.mode === 'browser' ? <Button type="button" variant="outline" size="sm" asChild><Link to="/settings" hash="browser-connection">Browser settings</Link></Button> : <Button ref={node => { if (node) connectionActions.current.set(connection.name, node); else connectionActions.current.delete(connection.name) }} type="button" variant="outline" size="sm" disabled={busy} onClick={() => guard.request(() => { if (active) closeEditor(); else void openEditor(connection.name) })}>{active ? 'Close' : connection.configured ? 'Manage' : 'Configure'}</Button>}
        </div>
      </div>
      {active && editing && <ProviderConnectionEditor key={`${editing.name}:${editing.revision}`} connection={editing} {...(catalog ? { catalog } : {})} onDirtyChange={setDirty} onBusyChange={setBusy} onCancel={() => guard.request(closeEditor)} onSaved={async () => {
        closeEditor()
        await refresh()
        addToast('Connection saved', 'positive')
      }} />}
      {active && connection.configured && <div className="mt-4 border-t border-default pt-4">
        <Button type="button" variant="ghost" size="sm" disabled={busy || !connection.capabilities.disconnect} onClick={() => guard.request(() => void previewDisconnect(connection.name))}>Disconnect {connection.displayName}</Button>
        {!connection.capabilities.disconnect && <p className="mt-1 text-copy-14 text-secondary">This connection must be removed on the host.</p>}
      </div>}
      {routed && connection.configured && projectSelection(connection.name, connection.kind)}
    </div>
  }

  const available = connections?.filter(connection => !connection.configured && connection.name !== editing?.name && `${connection.displayName} ${connection.name} ${connection.kind}`.toLowerCase().includes(search.trim().toLowerCase())) ?? []
  const existingMatches = search.trim() ? connections?.filter(connection => connection.configured && `${connection.displayName} ${connection.name} ${connection.kind}`.toLowerCase().includes(search.trim().toLowerCase())) ?? [] : []
  const catalogGroups = [
    { label: 'Direct providers', entries: available.filter(connection => connection.mode !== 'browser' && connection.kind === ProviderKinds['answer-engine']) },
    { label: 'Model gateways', entries: available.filter(connection => connection.kind === ProviderKinds['model-gateway']) },
    { label: 'Search answer services', entries: available.filter(connection => connection.kind === ProviderKinds['answer-service']) },
    { label: 'Browser providers', entries: available.filter(connection => connection.mode === 'browser') },
  ]

  return <section aria-labelledby="provider-connections-title" aria-busy={busy || settings.isLoading}>
    <div className="section-head">
      <h2 id="provider-connections-title">Provider connections</h2>
      {connections && <div className="flex flex-wrap gap-2">{connections.some(connection => connection.capabilities.reload) && <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => guard.request(() => void reload())}>Reload from host</Button>}<Button ref={addProviderAction} type="button" variant="outline" size="sm" disabled={busy} onClick={() => setAdding(current => !current)}>{adding ? 'Close catalog' : 'Add provider'}</Button></div>}
    </div>
    <p className="mb-4 text-copy-14 text-secondary">Save credentials and defaults here. Each project chooses the answer engines it runs.</p>
    {settings.isLoading && <p role="status" className="text-copy-14 text-secondary">Loading connections…</p>}
    {(settings.isError || error) && <div className="mb-4 space-y-2"><p role="alert" className="text-copy-14 text-negative-400">{error ?? 'Could not load provider connections.'}</p><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { setError(null); void settings.refetch() }}>Retry</Button></div>}
    {connections ? <>
      <div className="divide-y divide-default">{connections.filter(connection => connection.configured || connection.name === editing?.name).map(connectionRow)}</div>
      {!connections.some(connection => connection.configured) && !editing && <p className="py-4 text-copy-14 text-secondary">No provider connections configured. Add a provider to start choosing answer engines.</p>}
      {adding && <div className="mt-5 border-t border-default pt-4">
        <label htmlFor="provider-catalog-search" className="text-label-14 text-heading">Add provider</label>
        <input id="provider-catalog-search" type="search" className="setup-input mt-2 w-full" placeholder="Search providers" value={search} onChange={event => setSearch(event.target.value)} />
        {existingMatches.length > 0 && <div className="mt-4"><h3 className="text-label-12 text-secondary">Already connected</h3><div className="mt-1 space-y-2">{existingMatches.map(connection => <div key={connection.name} className="flex items-center justify-between gap-3"><span className="text-copy-14 text-heading">{connection.displayName}</span><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => guard.request(() => { setAdding(false); void openEditor(connection.name) })}>Manage {connection.displayName}</Button></div>)}</div></div>}
        {catalogGroups.filter(group => group.entries.length > 0).map(group => <div key={group.label} className="mt-4"><h3 className="text-label-12 text-secondary">{group.label}</h3><div className="mt-1 divide-y divide-default">{group.entries.map(connectionRow)}</div></div>)}
        {available.length === 0 && existingMatches.length === 0 && <p className="py-4 text-copy-14 text-secondary">{search ? 'No matching providers.' : 'All available providers are configured.'}</p>}
      </div>}
    </> : settings.data && <div className="divide-y divide-default">
      <p className="py-4 text-copy-14 text-secondary">This host supports connection setup. Saved credential details, resets and disconnect are unavailable here.</p>
      {settings.data.providers.map(provider => <div key={provider.name} id={`provider-${provider.name}`} className="scroll-mt-24 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-copy-14-strong text-heading">{provider.displayName ?? provider.name}</p><p className="text-copy-14 text-secondary">{provider.model ?? provider.defaultModel}</p></div><div className="flex items-center gap-2"><ToneBadge tone={provider.configured ? 'neutral' : 'caution'}>{provider.configured ? 'Configured' : 'Not configured'}</ToneBadge><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => guard.request(() => { setFallbackEditing(current => current === provider.name ? null : provider.name); setDirty(false) })}>{fallbackEditing === provider.name ? 'Cancel' : provider.configured ? 'Update' : 'Configure'}</Button></div></div>
        {fallbackEditing === provider.name && <ProviderConfigForm key={provider.name} providerName={provider.name} keyUrl={provider.keyUrl} modelHint={provider.modelHint} {...(provider.kind ? { kind: provider.kind } : {})} onDirtyChange={setDirty} onBusyChange={setBusy} onSaved={() => { setFallbackEditing(null); setDirty(false); void refresh() }} />}
        {provider.configured && (provider.name === 'openrouter' || provider.kind === ProviderKinds['model-gateway'] || provider.kind === ProviderKinds['answer-service']) && projectSelection(provider.name, provider.kind)}
      </div>)}
    </div>}
    {guard.dialog}
    <Dialog.Root open={disconnecting !== null} onOpenChange={open => { if (!open && !busy) setDisconnecting(null) }}><Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-50 bg-overlay-scrim/80" />
      <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100%_-_2rem)] w-[calc(100%_-_2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-lg border border-default bg-bg p-6 shadow-xl" onEscapeKeyDown={event => { if (busy) event.preventDefault() }} onPointerDownOutside={event => { if (busy) event.preventDefault() }}>
        <Dialog.Title className="text-heading-16 text-heading">Disconnect {disconnecting?.displayName}?</Dialog.Title>
        <Dialog.Description className="mt-2 text-copy-14 text-secondary">Remove this connection's saved configuration. Project selections and recorded history remain. Selected engines using it will be unavailable until it is configured again.</Dialog.Description>
        {disconnecting && <div className="mt-4 space-y-3 text-copy-14 text-secondary">
          <p>{disconnecting.usage.projectCount} {disconnecting.usage.projectCount === 1 ? 'project references' : 'projects reference'} this connection.</p>
          {disconnecting.usage.projects.length > 0 && <ul className="space-y-2">{disconnecting.usage.projects.map(project => <li key={project.name}><span className="text-heading">{project.displayName}</span><span className="block break-words text-label-12">{project.providers.map(provider => providerDisplayName(provider, settings.data?.providerCatalog)).join(', ')} · {project.sources.join(', ')}</span></li>)}</ul>}
          {disconnecting.hostUses.map(use => <p key={use}>Host usage: {use}</p>)}
          {disconnecting.blockers.map(blocker => <p key={blocker.code} role="status" className="text-caution-400">{blocker.message}</p>)}
          {!disconnecting.capabilities.disconnect && <p className="text-caution-400">This connection cannot be disconnected here.</p>}
        </div>}
        {disconnectError && <div className="mt-3 space-y-2"><p role="alert" className="text-copy-14 text-negative-400">{disconnectError}</p><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { if (disconnecting) void previewDisconnect(disconnecting.name) }}>Refresh impact</Button></div>}
        <div className="mt-5 flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => setDisconnecting(null)}>Keep connection</Button><Button type="button" variant="destructive" disabled={busy || !disconnecting?.capabilities.disconnect || disconnecting.blockers.some(blocker => blocker.code === 'outstanding-batches')} onClick={() => void disconnect()}>{busy ? 'Disconnecting…' : 'Disconnect'}</Button></div>
      </Dialog.Content>
    </Dialog.Portal></Dialog.Root>
  </section>
}
