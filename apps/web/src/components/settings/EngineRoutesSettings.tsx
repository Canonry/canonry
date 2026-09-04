import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getApiV1SettingsEngineConnectionsByIdModelsOptions,
  getApiV1SettingsEngineRoutesOptions,
  getApiV1SettingsOptions,
  getApiV1SettingsQueryKey,
  putApiV1SettingsEngineConnectionsByIdMutation,
  putApiV1SettingsEngineRoutesByIdMutation,
} from '@ainyc/canonry-api-client/react-query'
import type { EngineConnectionPublicDto, EngineRouteConfig } from '@ainyc/canonry-api-client'
import { describeError } from '@ainyc/canonry-contracts'

import { heyClient, isEmbed } from '../../api.js'
import { Button } from '../ui/button.js'
import { ToneBadge } from '../shared/ToneBadge.js'
import { asyncHandler } from '../../lib/async-handler.js'

type ConnectionPreset = EngineConnectionPublicDto['preset']

const PRESETS: ReadonlyArray<{ value: ConnectionPreset; label: string; endpoint: string }> = [
  { value: 'openrouter', label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1' },
  { value: 'litellm', label: 'LiteLLM', endpoint: 'http://localhost:4000' },
  { value: 'vercel-ai-gateway', label: 'Vercel AI Gateway', endpoint: 'https://ai-gateway.vercel.sh/v1' },
  { value: 'custom-openai-compatible', label: 'Custom OpenAI-compatible', endpoint: '' },
]

const INPUT_CLASS = 'mt-1 w-full rounded-md border border-strong bg-transparent px-3 py-2 text-sm text-strong placeholder-mono-600 focus:border-mono-500 focus:outline-none focus:ring-1 focus:ring-mono-500'

function defaultEndpoint(preset: ConnectionPreset): string {
  return PRESETS.find(item => item.value === preset)?.endpoint ?? ''
}

function presetLabel(preset: ConnectionPreset): string {
  return PRESETS.find(item => item.value === preset)?.label ?? preset
}

function quotaInput(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

function sourceLabel(source: EngineRouteConfig['source']): string {
  if (source === 'implicit-native') return 'Native'
  if (source === 'verified-adapter') return 'Verified adapter'
  return 'Configured'
}

function sourceOrder(source: EngineRouteConfig['source']): number {
  if (source === 'implicit-native') return 0
  if (source === 'verified-adapter') return 1
  return 2
}

function routeReadiness(route: EngineRouteConfig, connectionPresent: boolean): { label: string; tone: 'positive' | 'caution' | 'negative' } {
  if (route.source !== 'implicit-native' && !connectionPresent) return { label: 'Connection missing', tone: 'negative' }
  return route.capabilities.kind === 'verified-measurement'
    ? { label: 'Sweep ready', tone: 'positive' }
    : { label: 'Text-only', tone: 'caution' }
}

function readinessLabel(readiness: { state: string; measurementReady: boolean }): { label: string; tone: 'positive' | 'caution' | 'negative' } {
  if (readiness.state === 'unavailable') return { label: 'Unavailable', tone: 'negative' }
  return readiness.measurementReady
    ? { label: 'Sweep ready', tone: 'positive' }
    : { label: 'Text-only', tone: 'caution' }
}

/**
 * Credential-free route information for viewers. This deliberately calls the
 * separate safe endpoint rather than the administrator-only settings read.
 */
export function EngineRoutesReadOnlySummary() {
  const routesQuery = useQuery({
    ...getApiV1SettingsEngineRoutesOptions({ client: heyClient }),
    staleTime: 15_000,
  })
  const routes = [...(routesQuery.data?.routes ?? [])].sort((left, right) => (
    sourceOrder(left.source) - sourceOrder(right.source) || left.label.localeCompare(right.label)
  ))

  return (
    <section aria-labelledby="engine-routes-summary-title" className="page-section-divider">
      <div className="section-head">
        <div>
          <p className="eyebrow eyebrow-soft">Answer engines</p>
          <h2 id="engine-routes-summary-title">Available engine routes</h2>
        </div>
      </div>
      <p className="max-w-3xl text-sm text-secondary">A read-only summary of routes this install can use.</p>
      {routesQuery.isLoading && <p className="mt-4 text-sm text-secondary" aria-busy="true">Loading routes…</p>}
      {routesQuery.isError && <p role="alert" className="mt-4 text-sm text-negative-400">Could not load the available routes.</p>}
      {!routesQuery.isLoading && !routesQuery.isError && (
        <>
          <div className="mt-4 overflow-x-auto border-y border-default">
            <table className="w-full min-w-[560px] text-left text-sm" aria-label="Available engine routes">
              <caption className="sr-only">Route metadata that does not expose connection credentials or endpoints.</caption>
              <thead className="text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th scope="col" className="px-3 py-2">Route</th>
                  <th scope="col" className="px-3 py-2">Model</th>
                  <th scope="col" className="px-3 py-2">Readiness</th>
                  <th scope="col" className="px-3 py-2">Revision</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-default">
                {routes.map(route => {
                  const readiness = readinessLabel(route.readiness)
                  return (
                    <tr key={route.id}>
                      <td className="px-3 py-3"><p className="font-medium text-heading">{route.label}</p><p className="mt-0.5 font-mono text-xs text-muted">{sourceLabel(route.source)}</p></td>
                      <td className="px-3 py-3 font-mono text-xs text-secondary">{route.modelId}</td>
                      <td className="px-3 py-3"><ToneBadge tone={readiness.tone}>{readiness.label}</ToneBadge></td>
                      <td className="px-3 py-3 tabular-nums text-secondary">{route.revision}</td>
                    </tr>
                  )
                })}
                {routes.length === 0 && <tr><td colSpan={4} className="px-3 py-5 text-secondary">No answer-engine routes are available.</td></tr>}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-sm text-secondary">Text-only routes can support research, not answer-visibility sweeps.</p>
        </>
      )}
    </section>
  )
}

/**
 * Instance-level generic gateway configuration. Generic routes are deliberately
 * separate from native answer engines, because they cannot claim a citation or
 * location evidence contract just by speaking the OpenAI protocol.
 */
export function EngineRoutesSettings() {
  const embedded = isEmbed()
  const queryClient = useQueryClient()
  const settings = useQuery({
    ...getApiV1SettingsOptions({ client: heyClient }),
    staleTime: 15_000,
    enabled: !embedded,
  })
  const [connectionEditor, setConnectionEditor] = useState<EngineConnectionPublicDto | 'new' | null>(null)
  const [routeEditor, setRouteEditor] = useState<EngineRouteConfig | 'new' | null>(null)

  const connections = settings.data?.engineConnections ?? []
  const connectionIds = new Set(connections.map(connection => connection.id))
  const routes = [...(settings.data?.engineRoutes ?? [])].sort((left, right) => (
    sourceOrder(left.source) - sourceOrder(right.source) || left.label.localeCompare(right.label)
  ))
  if (embedded) return null

  if (settings.isLoading) {
    return (
      <section aria-labelledby="engine-routes-title" aria-busy="true" className="page-section-divider">
        <div className="section-head"><div><p className="eyebrow eyebrow-soft">Answer engines</p><h2 id="engine-routes-title">Engine routes</h2></div></div>
        <div className="h-24 animate-pulse rounded-lg bg-bg-elevated/40" aria-hidden="true" />
      </section>
    )
  }

  if (settings.isError && !settings.data) {
    return (
      <section aria-labelledby="engine-routes-title" className="page-section-divider">
        <div className="section-head"><div><p className="eyebrow eyebrow-soft">Answer engines</p><h2 id="engine-routes-title">Engine routes</h2></div></div>
        <p role="alert" className="text-sm text-negative-400">Could not load routes. Retry when settings are available.</p>
        <Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => void settings.refetch()}>Retry</Button>
      </section>
    )
  }

  return (
    <section aria-labelledby="engine-routes-title" className="page-section-divider">
      <div className="section-head section-head-inline">
        <div>
          <p className="eyebrow eyebrow-soft">Answer engines</p>
          <h2 id="engine-routes-title">Engine routes</h2>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => void settings.refetch()} disabled={settings.isFetching}>Refresh routes</Button>
          <Button type="button" variant="outline" size="sm" onClick={() => { setConnectionEditor(null); setRouteEditor('new') }} disabled={connections.length === 0}>Add route</Button>
          <Button type="button" size="sm" onClick={() => { setRouteEditor(null); setConnectionEditor('new') }}>Add connection</Button>
        </div>
      </div>
      <p className="max-w-3xl text-sm text-secondary">Native engines remain available. Add a gateway route for text tasks without making a sweep-evidence claim.</p>
      {settings.isError && <p role="alert" className="mt-3 text-sm text-caution-400">Could not refresh routes. Showing the last successful settings.</p>}

      <div className="mt-5 overflow-x-auto border-y border-default">
        <table className="w-full min-w-[720px] text-left text-sm" aria-label="Engine routes">
          <caption className="sr-only">Native and configured engine routes, including their measurement readiness.</caption>
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="px-3 py-2">Route</th>
              <th scope="col" className="px-3 py-2">Connection</th>
              <th scope="col" className="px-3 py-2">Model</th>
              <th scope="col" className="px-3 py-2">Readiness</th>
              <th scope="col" className="px-3 py-2">Revision</th>
              <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-default">
            {routes.map(route => {
              const readiness = routeReadiness(route, route.source === 'implicit-native' || connectionIds.has(route.connectionId))
              return (
                <tr key={route.id}>
                  <td className="px-3 py-3"><p className="font-medium text-heading">{route.label}</p><p className="mt-0.5 font-mono text-xs text-muted">{sourceLabel(route.source)}</p></td>
                  <td className="px-3 py-3 font-mono text-xs text-secondary">{route.connectionId}</td>
                  <td className="px-3 py-3 font-mono text-xs text-secondary">{route.modelId}</td>
                  <td className="px-3 py-3"><ToneBadge tone={readiness.tone}>{readiness.label}</ToneBadge></td>
                  <td className="px-3 py-3 tabular-nums text-secondary">{route.revision}</td>
                  <td className="px-3 py-3 text-right">
                    {route.source === 'configured' && <Button type="button" variant="outline" size="sm" aria-label={`Edit ${route.label}`} onClick={() => { setConnectionEditor(null); setRouteEditor(route) }}>Edit</Button>}
                  </td>
                </tr>
              )
            })}
            {routes.length === 0 && <tr><td colSpan={6} className="px-3 py-5 text-secondary">No routes are configured yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-sm text-secondary">Text-only routes can be used for research, not answer-visibility sweeps.</p>

      {routeEditor && (
        <RouteEditor
          key={routeEditor === 'new' ? 'new' : routeEditor.id}
          route={routeEditor === 'new' ? undefined : routeEditor}
          connections={connections}
          onCancel={() => setRouteEditor(null)}
          onSaved={() => {
            setRouteEditor(null)
            void queryClient.invalidateQueries({ queryKey: getApiV1SettingsQueryKey({ client: heyClient }) })
          }}
        />
      )}

      <div className="mt-6 flex flex-wrap items-end justify-between gap-3">
        <div><p className="eyebrow eyebrow-soft">Connections</p><h3 className="text-base font-medium text-heading">Gateway connections</h3></div>
      </div>
      {connections.length === 0 && <p className="mt-2 text-sm text-secondary">Save a connection before adding a route.</p>}
      <div className="mt-3 overflow-x-auto border-y border-default">
        <table className="w-full min-w-[720px] text-left text-sm" aria-label="Gateway connections">
          <caption className="sr-only">Gateway connection metadata without credentials.</caption>
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr>
              <th scope="col" className="px-3 py-2">Connection</th>
              <th scope="col" className="px-3 py-2">Endpoint</th>
              <th scope="col" className="px-3 py-2">Credential</th>
              <th scope="col" className="px-3 py-2">Quota</th>
              <th scope="col" className="px-3 py-2"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-default">
            {connections.map(connection => (
              <tr key={connection.id}>
                <td className="px-3 py-3"><p className="font-medium text-heading">{connection.label}</p><p className="mt-0.5 text-xs text-muted">{presetLabel(connection.preset)} · {connection.protocol}</p></td>
                <td className="px-3 py-3 font-mono text-xs text-secondary">{connection.baseUrl}</td>
                <td className="px-3 py-3"><ToneBadge tone={connection.secretConfigured ? 'positive' : 'caution'}>{connection.secretConfigured ? 'Saved API key' : 'No API key'}</ToneBadge></td>
                <td className="px-3 py-3 tabular-nums text-secondary">{connection.quota.maxConcurrency} concurrent · {connection.quota.maxRequestsPerMinute}/min · {connection.quota.maxRequestsPerDay}/day</td>
                <td className="px-3 py-3 text-right"><Button type="button" variant="outline" size="sm" aria-label={`Edit ${connection.label}`} onClick={() => { setRouteEditor(null); setConnectionEditor(connection) }}>Edit</Button></td>
              </tr>
            ))}
            {connections.length === 0 && <tr><td colSpan={5} className="px-3 py-5 text-secondary">No gateway connections configured.</td></tr>}
          </tbody>
        </table>
      </div>

      {connectionEditor && (
        <ConnectionEditor
          key={connectionEditor === 'new' ? 'new' : connectionEditor.id}
          connection={connectionEditor === 'new' ? undefined : connectionEditor}
          onCancel={() => setConnectionEditor(null)}
          onSaved={() => {
            setConnectionEditor(null)
            void queryClient.invalidateQueries({ queryKey: getApiV1SettingsQueryKey({ client: heyClient }) })
          }}
        />
      )}
    </section>
  )
}

function ConnectionEditor({ connection, onCancel, onSaved }: {
  connection?: EngineConnectionPublicDto
  onCancel: () => void
  onSaved: () => void
}) {
  const mutation = useMutation(putApiV1SettingsEngineConnectionsByIdMutation({ client: heyClient }))
  const [id, setId] = useState(connection?.id ?? 'connection:gateway')
  const [label, setLabel] = useState(connection?.label ?? '')
  const [preset, setPreset] = useState<ConnectionPreset>(connection?.preset ?? 'openrouter')
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? defaultEndpoint('openrouter'))
  const [apiKey, setApiKey] = useState('')
  const [maxConcurrency, setMaxConcurrency] = useState(String(connection?.quota.maxConcurrency ?? 3))
  const [maxRequestsPerMinute, setMaxRequestsPerMinute] = useState(String(connection?.quota.maxRequestsPerMinute ?? 60))
  const [maxRequestsPerDay, setMaxRequestsPerDay] = useState(String(connection?.quota.maxRequestsPerDay ?? 5000))
  const [error, setError] = useState<string | null>(null)

  function changePreset(next: ConnectionPreset) {
    setPreset(next)
    setBaseUrl(defaultEndpoint(next))
  }

  async function save() {
    const quota = {
      maxConcurrency: quotaInput(maxConcurrency),
      maxRequestsPerMinute: quotaInput(maxRequestsPerMinute),
      maxRequestsPerDay: quotaInput(maxRequestsPerDay),
    }
    if (!id.trim() || !label.trim() || !baseUrl.trim() || Object.values(quota).some(value => value === undefined)) {
      setError('Enter a stable ID, label, endpoint, and positive quota limits.')
      return
    }
    setError(null)
    try {
      await mutation.mutateAsync({
        path: { id: id.trim() },
        body: {
          label: label.trim(),
          preset,
          protocol: 'openai-compatible',
          baseUrl: baseUrl.trim(),
          quota: quota as { maxConcurrency: number; maxRequestsPerMinute: number; maxRequestsPerDay: number },
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        },
      })
      onSaved()
    } catch (cause) {
      setError(describeError(cause))
    }
  }

  return (
    <form className="mt-5 border-y border-default py-5" onSubmit={asyncHandler(async event => { event.preventDefault(); await save() })} aria-label={connection ? `Edit ${connection.label}` : 'Add connection'}>
      <div className="section-head"><div><p className="eyebrow eyebrow-soft">Connection</p><h3>{connection ? 'Edit gateway connection' : 'Add gateway connection'}</h3></div></div>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm text-secondary">Connection label<input aria-label="Connection label" className={INPUT_CLASS} value={label} onChange={event => setLabel(event.target.value)} autoFocus /></label>
        <label className="text-sm text-secondary">Connection ID<input aria-label="Connection ID" className={INPUT_CLASS} value={id} disabled={Boolean(connection)} onChange={event => setId(event.target.value)} /></label>
        <label className="text-sm text-secondary">Preset<select className={INPUT_CLASS} value={preset} onChange={event => changePreset(event.target.value as ConnectionPreset)}>{PRESETS.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
        <label className="text-sm text-secondary">Base URL<input aria-label="Base URL" className={INPUT_CLASS} value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://gateway.example.com/v1" /></label>
        <label className="text-sm text-secondary">API key<input aria-label="API key" type="password" autoComplete="new-password" className={INPUT_CLASS} value={apiKey} onChange={event => setApiKey(event.target.value)} /></label>
        <p className="self-end pb-2 text-sm text-secondary">{connection?.secretConfigured ? 'Leave blank to keep the saved key.' : 'Optional for an unauthenticated endpoint.'}</p>
      </div>
      <fieldset className="mt-4"><legend className="text-sm text-secondary">Connection quota</legend><div className="mt-1 grid gap-3 md:grid-cols-3">
        <label className="text-sm text-secondary">Concurrent<input className={INPUT_CLASS} type="number" min="1" value={maxConcurrency} onChange={event => setMaxConcurrency(event.target.value)} /></label>
        <label className="text-sm text-secondary">Per minute<input className={INPUT_CLASS} type="number" min="1" value={maxRequestsPerMinute} onChange={event => setMaxRequestsPerMinute(event.target.value)} /></label>
        <label className="text-sm text-secondary">Per day<input className={INPUT_CLASS} type="number" min="1" value={maxRequestsPerDay} onChange={event => setMaxRequestsPerDay(event.target.value)} /></label>
      </div></fieldset>
      {error && <p role="alert" className="mt-3 text-sm text-negative-400">{error}</p>}
      <div className="mt-4 flex gap-2"><Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? 'Saving connection…' : 'Save connection'}</Button><Button type="button" variant="outline" onClick={onCancel} disabled={mutation.isPending}>Cancel</Button></div>
    </form>
  )
}

function RouteEditor({ route, connections, onCancel, onSaved }: {
  route?: EngineRouteConfig
  connections: EngineConnectionPublicDto[]
  onCancel: () => void
  onSaved: () => void
}) {
  const mutation = useMutation(putApiV1SettingsEngineRoutesByIdMutation({ client: heyClient }))
  const [id, setId] = useState(route?.id ?? 'route:')
  const [label, setLabel] = useState(route?.label ?? '')
  const [connectionId, setConnectionId] = useState(route?.connectionId ?? (connections.length > 0 ? connections[0]!.id : ''))
  const [modelId, setModelId] = useState(route?.modelId ?? '')
  const [catalogRequestedFor, setCatalogRequestedFor] = useState<string | null>(null)
  const [catalogFilter, setCatalogFilter] = useState('')
  const [catalogModelId, setCatalogModelId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const catalog = useQuery({
    ...getApiV1SettingsEngineConnectionsByIdModelsOptions({
      client: heyClient,
      path: { id: connectionId || 'connection:unselected' },
    }),
    enabled: Boolean(connectionId) && catalogRequestedFor === connectionId,
    retry: false,
  })
  const catalogModels = catalog.data?.state === 'available'
    ? catalog.data.models.filter(model => {
      const needle = catalogFilter.trim().toLocaleLowerCase()
      if (!needle) return true
      return [model.id, model.displayName, model.provider]
        .filter((value): value is string => Boolean(value))
        .some(value => value.toLocaleLowerCase().includes(needle))
    })
    : []

  function changeConnection(nextConnectionId: string) {
    setConnectionId(nextConnectionId)
    setCatalogRequestedFor(null)
    setCatalogFilter('')
    setCatalogModelId('')
  }

  function loadCatalog() {
    if (!connectionId) return
    if (catalogRequestedFor === connectionId) {
      void catalog.refetch()
      return
    }
    setCatalogFilter('')
    setCatalogRequestedFor(connectionId)
  }

  async function save() {
    if (!id.trim() || !label.trim() || !connectionId || !modelId.trim()) {
      setError('Enter a route ID, label, connection, and model ID.')
      return
    }
    setError(null)
    try {
      await mutation.mutateAsync({
        path: { id: id.trim() },
        body: { label: label.trim(), connectionId, modelId: modelId.trim() },
      })
      onSaved()
    } catch (cause) {
      setError(describeError(cause))
    }
  }

  return (
    <form className="mt-5 border-y border-default py-5" onSubmit={asyncHandler(async event => { event.preventDefault(); await save() })} aria-label={route ? `Edit ${route.label}` : 'Add route'}>
      <div className="section-head"><div><p className="eyebrow eyebrow-soft">Route</p><h3>{route ? 'Edit route' : 'Add route'}</h3></div></div>
      <p className="text-sm text-caution-400">Generic routes are text-only until a verified evidence adapter is installed.</p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="text-sm text-secondary">Route label<input aria-label="Route label" className={INPUT_CLASS} value={label} onChange={event => setLabel(event.target.value)} autoFocus /></label>
        <label className="text-sm text-secondary">Route ID<input aria-label="Route ID" className={INPUT_CLASS} value={id} disabled={Boolean(route)} onChange={event => setId(event.target.value)} /></label>
        <label className="text-sm text-secondary">Connection<select className={INPUT_CLASS} value={connectionId} onChange={event => changeConnection(event.target.value)}>{connections.map(connection => <option key={connection.id} value={connection.id}>{connection.label}</option>)}</select></label>
        <label className="text-sm text-secondary">Model ID<input aria-label="Model ID" className={INPUT_CLASS} value={modelId} onChange={event => setModelId(event.target.value)} placeholder="provider/model-id" /></label>
      </div>
      <div className="mt-4 border-t border-default pt-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-sm font-medium text-heading">Connection model catalog</p>
            <p className="mt-1 text-sm text-secondary">Optional discovery only. Loading it never changes the manual model ID.</p>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={loadCatalog} disabled={!connectionId || catalog.isFetching}>
            {catalog.isFetching ? 'Loading models…' : 'Load model catalog'}
          </Button>
        </div>
        {catalogRequestedFor === connectionId && catalog.isError && <p role="alert" className="mt-3 text-sm text-negative-400">Could not load the model catalog. Enter a model ID manually.</p>}
        {catalogRequestedFor === connectionId && catalog.data?.state === 'unavailable' && <p role="status" className="mt-3 text-sm text-secondary">This connection does not currently provide a model catalog. Enter a model ID manually.</p>}
        {catalogRequestedFor === connectionId && catalog.data?.state === 'available' && (
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            <label className="text-sm text-secondary">Search model catalog<input aria-label="Search model catalog" type="search" className={INPUT_CLASS} value={catalogFilter} onChange={event => setCatalogFilter(event.target.value)} placeholder="Search model IDs" /></label>
            <label className="text-sm text-secondary">Catalog model<select aria-label="Catalog model ID" className={INPUT_CLASS} value={catalogModelId} onChange={event => {
              setCatalogModelId(event.target.value)
              if (event.target.value) setModelId(event.target.value)
            }}>
              <option value="">Select a catalog model</option>
              {catalogModels.map(model => <option key={model.id} value={model.id}>{model.displayName ?? model.id}{model.displayName && model.provider ? ` · ${model.provider}` : ''}</option>)}
            </select></label>
            {catalogModels.length === 0 && <p className="text-sm text-secondary md:col-span-2">No catalog models match this search. Enter a model ID manually.</p>}
          </div>
        )}
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-negative-400">{error}</p>}
      <div className="mt-4 flex gap-2"><Button type="submit" disabled={mutation.isPending}>{mutation.isPending ? 'Saving route…' : 'Save route'}</Button><Button type="button" variant="outline" onClick={onCancel} disabled={mutation.isPending}>Cancel</Button></div>
    </form>
  )
}
