import { useEffect, useId, useRef, useState, type ReactNode, type ComponentProps } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import * as Dialog from '@radix-ui/react-dialog'
import { describeError, isOpenRouterRoute, ProviderConnectionsUnavailableReasons, ProviderKinds, ProviderNames, ProviderQuotaFields, type ProviderCatalogEntryDto, type ProviderConnectionSettingsDto, type ProviderConnectionsUnavailableReason, type ProviderQuotaField, type ProviderSettingsUpdateRequest, type SettingsDto } from '@canonry/canonry-contracts'

import { Button } from '../ui/button.js'
import { disconnectProvider, fetchProviderConnection, fetchSettings, reloadProviderConnections, updateProviderConfig } from '../../api.js'
import { useUnsavedChanges } from '../../hooks/use-unsaved-changes.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { addToast } from '../../lib/toast-store.js'
import { asyncHandler } from '../../lib/async-handler.js'
import { invalidateProjectQueryDomain } from '../../queries/query-invalidation.js'
import { providerDisplayName } from '../../lib/visibility-trend-helpers.js'
import { InfoTooltip } from '../shared/InfoTooltip.js'
import { forgetProviderConnectionTests, isConnectedRecord, useProviderConnectionTestRecords, useProviderConnectionTests, type ProviderConnectionTestRecord, type ProviderConnectionTestTarget } from '../../queries/provider-connection-tests.js'
import { PROVIDER_CONNECTION_TEST_COPY, ProviderConnectionTestLine, providerConnectionStatus } from './ProviderConnectionTest.js'

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
        forgetProviderConnectionTests(queryClient, providerName)
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['settings'] }),
          invalidateProjectQueryDomain(queryClient, 'runAdmission'),
        ])
        addToast({ title: 'Connection saved', detail: 'Test the connection to verify access.', tone: 'positive' })
        props.onSaved()
      }}
    />
    {props.secondaryActions}
  </div>
}

function NewProviderConfigForm({ providerName, keyUrl, modelHint, defaultModel, kind, compact = false, offerFreeTier = true, leadingField, secondaryActions, saveLabel, onSaved, onDirtyChange, onBusyChange }: {
  providerName: string
  keyUrl?: string
  /** The server's example for the model field, shown only when the default model is unknown. */
  modelHint?: string
  /** The model the provider runs when the model field is left blank. */
  defaultModel?: string
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
  /** Names what saving leads to when the caller shows a next step, such as choosing models. */
  saveLabel?: string
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
      forgetProviderConnectionTests(queryClient, providerName.toLowerCase())
      // A new key, model or endpoint lifts that provider's hold on every
      // project, so their notices and sweep buttons must not wait for staleness.
      void invalidateProjectQueryDomain(queryClient, 'runAdmission')
      // The model catalog is read with the saved credential, so a corrected key
      // must reach any open model picker now, not after the settings read goes stale.
      void queryClient.invalidateQueries({ queryKey: ['settings'] })
      addToast({
        title: 'Provider updated',
        detail: `${providerDisplayName(providerName)} configuration saved.`,
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

  const labelClassName = compact ? 'block text-label-14-strong text-secondary' : 'text-label-14 text-secondary'
  // The shared field style, so focus reads stronger than rest here as in every other form.
  const inputClassName = compact ? 'setup-input min-h-11 w-full' : 'setup-input mt-0.5 w-full'
  const quotaInputs = [
    { id: `quota-concurrency-${providerName}`, label: 'Max concurrent', placeholder: 'Concurrent', value: maxConcurrency, onChange: setMaxConcurrency },
    { id: `quota-per-minute-${providerName}`, label: 'Per minute', placeholder: '/min', value: maxPerMinute, onChange: setMaxPerMinute },
    { id: `quota-per-day-${providerName}`, label: 'Per day', placeholder: '/day', value: maxPerDay, onChange: setMaxPerDay },
  ]

  const optionalFields = (
    <>
      {!routedConnection && <div className={compact ? 'space-y-1.5' : undefined}>
        <label className={labelClassName} htmlFor={`model-${providerName}`}>Model (optional)</label>
        <input
          id={`model-${providerName}`}
          type="text"
          className={inputClassName}
          placeholder={defaultModel ?? modelHint ?? 'Model ID'}
          aria-describedby={`model-default-${providerName}`}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
        {/* A blank field still runs a model; name it rather than leave it to the placeholder. */}
        <p id={`model-default-${providerName}`} className="mt-1 text-copy-14 text-secondary">
          {defaultModel ? `Default model: ${defaultModel}` : 'Leave blank to use the provider’s default model.'}
        </p>
      </div>}
      <fieldset className="min-w-0">
        <legend className={labelClassName}>Quota (optional)</legend>
        <div className="mt-0.5 grid grid-cols-3 gap-1.5">
          {quotaInputs.map(field => (
            <div key={field.id}>
              <input
                id={field.id}
                type="number"
                min="1"
                className={compact ? inputClassName : 'setup-input w-full'}
                placeholder={field.placeholder}
                value={field.value}
                onChange={(e) => field.onChange(e.target.value)}
              />
              <label htmlFor={field.id} className="mt-1 block text-copy-14 text-secondary">{field.label}</label>
            </div>
          ))}
        </div>
      </fieldset>
    </>
  )

  const localEndpointField = isLocal ? (
    <div className={compact ? 'min-w-0 space-y-1.5' : undefined}>
      <label className={labelClassName} htmlFor={`base-url-${providerName}`}>Base URL</label>
      <input
        id={`base-url-${providerName}`}
        type="text"
        className={inputClassName}
        placeholder="http://localhost:11434/v1"
        aria-describedby={`base-url-help-${providerName}`}
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
      />
      <p id={`base-url-help-${providerName}`} className="mt-1 text-copy-14 text-secondary">Use any OpenAI-compatible endpoint, such as Ollama or vLLM.</p>
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
      {saving ? 'Saving\u2026' : saveLabel ?? (compact ? 'Save connection' : 'Save')}
    </Button>
  )
  // A local server needs its endpoint and rarely a key, so the required field leads.
  const firstField = isLocal ? localEndpointField : apiKeyField
  const secondField = isLocal ? apiKeyField : null

  return (
    <div className={compact ? 'space-y-3' : 'mt-3 space-y-2'}>
      {showGeminiFreeTier && (
        <div className="space-y-1 pb-2">
          <h3 className="text-heading-16 text-heading">Connect Gemini</h3>
          {/* The key link stays in the sentence so pasting a key and saving remain the primary path. */}
          <p className="max-w-prose text-copy-14 text-secondary">
            <a href={keyUrl} target="_blank" rel="noopener noreferrer" className="text-link underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2">
              Get a key in Google AI Studio {'\u2197'}
            </a>
            . Free usage depends on the model and your account.{' '}
            <a href="https://ai.google.dev/gemini-api/docs/pricing" target="_blank" rel="noopener noreferrer" className="text-link underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2">
              Pricing and limits
            </a>
          </p>
        </div>
      )}
      {compact ? (
        <>
          <div className={leadingField ? 'grid items-start gap-3 sm:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]' : undefined}>
            {leadingField}
            {firstField}
          </div>
          {secondField}
        </>
      ) : <>{firstField}{secondField}</>}
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
  // Only saved settings can be tested, at the revision this editor shows.
  const connectionTest = useProviderConnectionTests([{ name: connection.name, revision: connection.revision, lastTest: connection.lastTest }])
  // An engine's or gateway's test is a request on the operator's provider account. A browser
  // connection's reaches Chrome, and a search answer service's is a free key check or none.
  const testSendsRequest = connection.configured && connection.mode !== 'browser' && connection.kind !== ProviderKinds['answer-service']
  const testRecord = connectionTest.records[0]
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
        <p className="text-copy-14 text-secondary">{connection.apiKeyConfigured ? 'Saved key. Test the connection to verify access.' : 'No API key is saved.'}{catalog?.keyUrl && <> <a className="text-link" href={catalog.keyUrl} target="_blank" rel="noreferrer">Get an API key</a></>}</p>
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
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={!dirty}>{saving ? 'Saving…' : 'Save connection'}</Button>
        <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
        {connection.configured && <Button type="button" variant="outline" disabled={dirty || connectionTest.testing} aria-describedby={testSendsRequest ? `${id}-test-notice ${id}-test-status` : `${id}-test-status`} onClick={connectionTest.test}>{connectionTest.testing ? PROVIDER_CONNECTION_TEST_COPY.testing : PROVIDER_CONNECTION_TEST_COPY.testOne}</Button>}
        {dirty && <span className="text-label-12 text-secondary">Unsaved changes</span>}
      </div>
      {testSendsRequest && <p id={`${id}-test-notice`} className="text-copy-14 text-secondary">{PROVIDER_CONNECTION_TEST_COPY.sends([connection.displayName])}</p>}
      {connection.configured && <div id={`${id}-test-status`} role="status">
        {dirty
          ? <p className="text-copy-14 text-secondary">{PROVIDER_CONNECTION_TEST_COPY.saveFirst}</p>
          : testRecord && <ProviderConnectionTestLine record={testRecord} />}
      </div>}
    </fieldset>
  </form>
}

export const PROVIDER_CONNECTIONS_COPY = {
  configUnreadable: 'Saved connection settings could not be read',
  internalError: 'Connection details could not be loaded',
  configuredOnServer: 'Configured on this server',
  noneConnected: 'No answer engines are connected yet.',
  usageUnknown: (count: number) => `Usage unknown for ${count} ${count === 1 ? 'project' : 'projects'}`,
  usageUnknownDetail: (count: number) => count === 1
    ? 'Saved measurement settings could not be read for 1 project, so whether it uses this connection is unknown.'
    : `Saved measurement settings could not be read for ${count} projects, so whether they use this connection is unknown.`,
} as const

/** The server's reason decides the heading and whether re-reading can help; its message carries the instructions. */
function unavailableView(reason: ProviderConnectionsUnavailableReason): { title: string; retry: boolean } {
  switch (reason) {
    // Repairing the file is only half the fix; the message sends the operator to Reload from config file.
    case ProviderConnectionsUnavailableReasons['config-unreadable']: return { title: PROVIDER_CONNECTIONS_COPY.configUnreadable, retry: false }
    case ProviderConnectionsUnavailableReasons['internal-error']: return { title: PROVIDER_CONNECTIONS_COPY.internalError, retry: true }
  }
}

function usageSummary(usage: ProviderConnectionSettingsDto['usage']): string {
  return [
    usage.projectCount > 0 ? `Used by ${usage.projectCount} ${usage.projectCount === 1 ? 'project' : 'projects'}` : '',
    usage.unknown ? PROVIDER_CONNECTIONS_COPY.usageUnknown(usage.unknown.projectCount) : '',
  ].filter(part => part !== '').join(' · ')
}

function ConnectionStatusBadge({ result }: { result: ProviderConnectionTestRecord | undefined }) {
  const status = providerConnectionStatus([result])
  return <ToneBadge tone={status.tone}>{status.label}</ToneBadge>
}

export function ProviderConnectionsSection({ projects }: { projects: { name: string; displayName?: string | null; providers: string[] }[] }) {
  const queryClient = useQueryClient()
  // Typed by the wire contract so the connection-list state the server reports is readable here.
  const settings = useQuery<SettingsDto>({ queryKey: ['settings'], queryFn: fetchSettings, staleTime: 60_000 })
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
  const unavailable = settings.data?.providerConnectionsUnavailable
  // Rows show the latest test of the settings they list, the server's or this tab's; without
  // connection details, only this tab's. The browser connection's live status belongs to its
  // own card, which checks Chrome on open.
  const testTargets: ProviderConnectionTestTarget[] = connections
    ? connections.filter(connection => connection.configured && connection.mode !== 'browser').map(connection => ({ name: connection.name, revision: connection.revision, lastTest: connection.lastTest }))
    : (settings.data?.providers ?? []).filter(provider => provider.configured).map(provider => ({ name: provider.name }))
  const tested = useProviderConnectionTestRecords(testTargets)
  const testIndex = (name: string) => testTargets.findIndex(target => target.name === name)
  const testResult = (name: string) => tested.results[testIndex(name)]
  const testRecord = (name: string) => tested.records[testIndex(name)]
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
      forgetProviderConnectionTests(queryClient, disconnecting.name)
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
      forgetProviderConnectionTests(queryClient)
      await refresh()
      addToast('Connections reloaded from the config file', 'positive')
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
    const usage = usageSummary(connection.usage)
    const browser = connection.mode === 'browser'
    const record = connection.configured && !browser ? testRecord(connection.name) : undefined
    const status = browser ? { label: 'Configured', tone: 'neutral' as const } : providerConnectionStatus([connection.configured ? testResult(connection.name) : undefined])
    // A catalog row sits under a heading that already names its kind, so it repeats only a saved endpoint.
    const inCatalog = !connection.configured && !active
    const kindLine = browser ? 'Browser connection' : connection.kind === ProviderKinds['model-gateway'] ? 'Model gateway' : connection.kind === ProviderKinds['answer-service'] ? 'Search answer service · choose profiles in each project' : connection.effectiveModel ?? 'Direct answer engine'
    const detail = inCatalog ? connection.baseUrl : `${kindLine}${connection.baseUrl ? ` · ${connection.baseUrl}` : ''}`
    return <div key={connection.name} id={`provider-${connection.name}`} className={`scroll-mt-24 ${inCatalog ? 'py-3' : 'py-4'}`}>
      <div className={`flex flex-wrap justify-between gap-x-4 gap-y-2 ${detail || usage ? 'items-start' : 'items-center'}`}>
        <div className="min-w-0 grow basis-64">
          <p className="text-copy-14-strong text-heading">{connection.displayName}</p>
          {detail && <p className="mt-1 break-words text-copy-14 text-secondary">{detail}</p>}
          {usage && <p className="mt-1 text-label-12 text-secondary">{usage}</p>}
          {!active && record && !isConnectedRecord(record) && <div className="mt-1"><ProviderConnectionTestLine record={record} /></div>}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {(connection.configured || active) && <ToneBadge tone={connection.configured ? status.tone : 'caution'}>{connection.configured ? status.label : 'Not configured'}</ToneBadge>}
          {managed && connection.mode !== 'browser' && <span className="text-label-12 text-secondary">Host managed</span>}
          {connection.mode === 'browser' ? <Button type="button" variant="outline" size="sm" asChild><Link to="/settings" hash="browser-connection">Browser settings</Link></Button> : <Button ref={node => { if (node) connectionActions.current.set(connection.name, node); else connectionActions.current.delete(connection.name) }} type="button" variant="outline" size="sm" disabled={busy} onClick={() => guard.request(() => { if (active) closeEditor(); else void openEditor(connection.name) })}>{active ? 'Close' : connection.configured ? 'Manage' : 'Configure'}</Button>}
        </div>
      </div>
      {active && editing && <ProviderConnectionEditor key={`${editing.name}:${editing.revision}`} connection={editing} {...(catalog ? { catalog } : {})} onDirtyChange={setDirty} onBusyChange={setBusy} onCancel={() => guard.request(closeEditor)} onSaved={async () => {
        forgetProviderConnectionTests(queryClient, connection.name)
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

  const unavailableState = unavailable ? { ...unavailableView(unavailable.reason), message: unavailable.message } : null
  // With nothing connected, choosing a provider is the only next step, so the catalog is open.
  const noneConfigured = connections !== undefined && !connections.some(connection => connection.configured)
  const catalogOpen = adding || (noneConfigured && !editing)
  const configuredOnServer = settings.data?.providers.filter(provider => provider.configured) ?? []

  return <section aria-labelledby="provider-connections-title" aria-busy={busy || settings.isLoading}>
    <div className="section-head flex-wrap">
      <div className="flex items-center gap-1">
        <h2 id="provider-connections-title" className="text-heading-16 text-heading">Provider connections</h2>
        <InfoTooltip text="Save credentials and defaults here. Each project chooses the answer engines it runs." />
      </div>
      {(connections || unavailable) && <div className="flex flex-wrap gap-2">{(unavailable || connections?.some(connection => connection.capabilities.reload)) && <span className="inline-flex items-center"><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => guard.request(() => void reload())}>Reload from config file</Button><InfoTooltip text="Re-read provider keys, models and quotas from this server's config file, for example after editing it. Makes no provider calls." /></span>}{connections && !noneConfigured && <Button ref={addProviderAction} type="button" variant="outline" size="sm" disabled={busy} onClick={() => setAdding(current => !current)}>{adding ? 'Close catalog' : 'Add provider'}</Button>}</div>}
    </div>
    {settings.isLoading && <p role="status" className="text-copy-14 text-secondary">Loading connections…</p>}
    {(settings.isError || error) && <div className="mb-4 space-y-2"><p role="alert" className="text-copy-14 text-negative-400">{error ?? 'Could not load provider connections.'}</p><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { setError(null); void settings.refetch() }}>Retry</Button></div>}
    {unavailableState ? <div className="space-y-4">
      <div role="alert" className="space-y-1">
        <p className="text-copy-14-strong text-heading">{unavailableState.title}</p>
        <p className="text-copy-14 text-secondary">{unavailableState.message}</p>
      </div>
      {unavailableState.retry && <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { setError(null); void settings.refetch() }}>Retry</Button>}
      {/* An editor opened before the list became unavailable keeps its unsaved draft; saving reports the server's refusal. */}
      {editing && <div className="divide-y divide-default">{connectionRow(editing)}</div>}
      {configuredOnServer.length > 0 && <div>
        <h3 className="text-label-12 text-secondary">{PROVIDER_CONNECTIONS_COPY.configuredOnServer}</h3>
        <div className="mt-1 divide-y divide-default">{configuredOnServer.map(provider => <div key={provider.name} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div className="min-w-0"><p className="text-copy-14-strong text-heading">{provider.displayName ?? provider.name}</p>{(provider.model ?? provider.defaultModel) && <p className="break-words text-copy-14 text-secondary">{provider.model ?? provider.defaultModel}</p>}</div>
          <ConnectionStatusBadge result={testResult(provider.name)} />
        </div>)}</div>
      </div>}
    </div> : connections ? <>
      <div className="divide-y divide-default">{connections.filter(connection => connection.configured || connection.name === editing?.name).map(connectionRow)}</div>
      {noneConfigured && !editing && <p className="mt-2 text-copy-14 text-secondary">{PROVIDER_CONNECTIONS_COPY.noneConnected}</p>}
      {catalogOpen && <div className={noneConfigured && !editing ? 'mt-4' : 'mt-5 border-t border-default pt-4'}>
        <label htmlFor="provider-catalog-search" className="text-label-14 text-heading">Add provider</label>
        <input id="provider-catalog-search" type="search" className="setup-input mt-2 w-full" placeholder="Search providers" value={search} onChange={event => setSearch(event.target.value)} />
        {existingMatches.length > 0 && <div className="mt-4"><h3 className="text-label-12 text-secondary">Already connected</h3><div className="mt-1 space-y-2">{existingMatches.map(connection => <div key={connection.name} className="flex items-center justify-between gap-3"><span className="text-copy-14 text-heading">{connection.displayName}</span><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => guard.request(() => { setAdding(false); void openEditor(connection.name) })}>Manage {connection.displayName}</Button></div>)}</div></div>}
        {catalogGroups.filter(group => group.entries.length > 0).map(group => <div key={group.label} className="mt-4"><h3 className="text-label-12 text-secondary">{group.label}</h3><div className="mt-1 divide-y divide-default">{group.entries.map(connectionRow)}</div></div>)}
        {available.length === 0 && existingMatches.length === 0 && <p className="py-4 text-copy-14 text-secondary">{search ? 'No matching providers.' : 'All available providers are configured.'}</p>}
      </div>}
    </> : settings.data && <div className="divide-y divide-default">
      <p className="py-4 text-copy-14 text-secondary">This host supports connection setup. Saved credential details, resets and disconnect are unavailable here.</p>
      {settings.data.providers.map(provider => <div key={provider.name} id={`provider-${provider.name}`} className="scroll-mt-24 py-4">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-copy-14-strong text-heading">{provider.displayName ?? provider.name}</p><p className="text-copy-14 text-secondary">{provider.model ?? provider.defaultModel}</p></div><div className="flex items-center gap-2">{provider.configured ? <ConnectionStatusBadge result={testResult(provider.name)} /> : <ToneBadge tone="caution">Not configured</ToneBadge>}<Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => guard.request(() => { setFallbackEditing(current => current === provider.name ? null : provider.name); setDirty(false) })}>{fallbackEditing === provider.name ? 'Cancel' : provider.configured ? 'Update' : 'Configure'}</Button></div></div>
        {fallbackEditing === provider.name && <ProviderConfigForm key={provider.name} providerName={provider.name} keyUrl={provider.keyUrl} modelHint={provider.modelHint} defaultModel={provider.defaultModel} {...(provider.kind ? { kind: provider.kind } : {})} onDirtyChange={setDirty} onBusyChange={setBusy} onSaved={() => { setFallbackEditing(null); setDirty(false); void refresh() }} />}
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
          {disconnecting.usage.unknown && <div role="status" className="space-y-2">
            <p className="text-caution-400">{PROVIDER_CONNECTIONS_COPY.usageUnknownDetail(disconnecting.usage.unknown.projectCount)}</p>
            <ul className="space-y-2">{disconnecting.usage.unknown.projects.map(project => <li key={project.name}><span className="text-heading">{project.displayName}</span><span className="block break-words text-label-12">Unreadable: {project.sources.join(', ')}</span></li>)}</ul>
          </div>}
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
